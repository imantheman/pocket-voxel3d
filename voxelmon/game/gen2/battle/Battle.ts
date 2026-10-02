// Gen 2 battle engine: a port of gen1recomp src/battle/gen2/Battle.lua
// (bdfac727, MIT). The turn loop, as pure logic.
//
// No love calls and no rendering: a battle is a state machine that consumes
// actions and produces a queue of events, so the same engine drives the screen
// (src/ui/gen2/BattleState.lua), a headless driver, and the tests.  Gen 1's
// src/battle/BattleState.lua interleaves logic with drawing, which is exactly
// what makes its turn order hard to assert; this does not repeat that.
//
// Ported from engine/battle/core.asm's turn structure:
//   * both sides choose (a move, an item, a switch, or run)
//   * order is by Speed after stat stages, with a coin flip on a tie
//     (DetermineMoveOrder); a switch or item always goes first
//   * each attack: PP, status gates (sleep/freeze/paralysis), accuracy, damage,
//     then the move's secondary effect
//   * end of turn: burn and poison tick, then faint checks and experience
//
// Status handling follows Gen 2's rules rather than Gen 1's: burn is 1/8 max HP
// (not 1/16) and halves physical Attack, poison is 1/8, and sleep counts down
// from 2-7 turns.
//
// Port notes (TypeScript side):
//   * Party slot numbers stay the Lua's 1-based values: `playerIndex`,
//     `enemyIndex`, `firstHealthy()`'s answer and the `participants` keys.
//     The arrays themselves are 0-based, so `self.party[self.playerIndex]`
//     reads `this.party[this.playerIndex - 1]`.
//   * Lua multiple returns come back as tuples: `hiddenPower` ->
//     [power, type], `heldEffect` -> [effect, parameter], `hitOnce` ->
//     [damage, info] (as Damage.calc and Effects.magnitudePower do).
//
// The mod event/hook buses (Runtime).  Every name raised from this file is the
// SAME name src/battle/BattleState.lua raises on Gen 1, carrying the same
// payload keys with the same meaning (docs/mod-api-gen2-compat.md).  Gen 1's
// `rng` is love.math.random (rng(n) -> 1..n, rng(lo,hi) -> lo..hi); Gen 2's
// cart BattleRandom is random(n) -> 0..n-1.  Both live on the battle:
// `random` / `roller()` are BattleRandom for damage, accuracy, Magnitude,
// etc.; `rng` is the Gen 1 / love-style view of the same stream.

import { Damage } from "./Damage.ts";
import { Ai } from "./Ai.ts";
import { Effects } from "./Effects.ts";
import { Mon } from "./Mon.ts";
import { Prize } from "./Prize.ts";
import { Happiness } from "../core/Happiness.ts";
import { Pokerus } from "../core/Pokerus.ts";
import { Roamers } from "../core/Roamers.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";
import { truthy, idiv, mod, format, sortedKeys, insertAt, removeAt, tostring, tonumber, sub } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";

// (Prize, Pokerus, Roamers, format, insertAt, removeAt, tostring and sub are
// for parts B and C of this file.  No top-level `void` reads: a circular
// import touched at module top level would hit its TDZ.)

/** BattleRandom: `random(n)` returning 0..n-1. */
export type ZeroRandom = (n: number) => number;
/** The Gen 1 / love.math view: rng(n) -> 1..n, rng(lo, hi) -> lo..hi. */
export type LoveRng = (lo?: number, hi?: number) => number;
/** A party mon, move row or event: open Lua tables. */
type BattleMon = any;

// Lua `x or nil`: x when it is Lua-true, else nil.
function orNil<T>(v: T): T | undefined {
  return truthy(v) ? v : undefined;
}

// Lua: Battle.lua:86
function rand(randomFn: ZeroRandom | null | undefined | false, n: number): number {
  if (truthy(randomFn)) return (randomFn as ZeroRandom)(n);
  // love.math.random(n) - 1 / math.random(n) - 1: the one seeded stream here.
  return random(n) - 1;
}

// Gen 1 / love.math view of BattleRandom: rng(n) -> 1..n, rng(lo,hi) -> lo..hi.
// Lua: Battle.lua:95
function loveStyleRng(randomFn: ZeroRandom | null | undefined): LoveRng {
  return function (lo?: number, hi?: number): number {
    if (hi == null) {
      let n = lo ?? 1;
      if (n < 1) n = 1;
      return (rand(randomFn, n) ?? 0) + 1;
    }
    let a = lo as number;
    let b = hi;
    if (b < a) [a, b] = [b, a];
    return a + (rand(randomFn, b - a + 1) ?? 0);
  };
}

// Can this mon act?  Returns true, or false plus the message the cart prints.
// `moveId` is wCurPlayerMove / wCurEnemyMove (effect_commands.asm:193).
// Lua: Battle.lua:974
function clearBide(state: Record<string, any>): void {
  state.bideTurns = undefined;
  state.bideStored = undefined;
  state.bideMove = undefined;
}

// Lua: Battle.lua:978
function checkTurn(self: Battle, mon: BattleMon, moveId: string | undefined): boolean {
  const name = self.monName(mon);
  // SUBSTATUS_RECHARGE, and it is checked BEFORE status: CheckPlayerTurn reads
  // it first, clears it, prints MustRechargeText and jumps to EndTurn, so a mon
  // that is both recharging and asleep spends this turn recharging.
  const vol = self.volatile(mon);
  if (truthy(vol.recharge)) {
    vol.recharge = undefined;
    self.emit({ kind: "message", text: Strings.get("%s must recharge!", name) });
    return false;
  }
  // The status arms, through the merged record.  beforeMovePriority is what
  // puts sleep (40) and freeze (30) ahead of the flinch/confusion block and
  // paralysis (10) after it, the way CheckPlayerTurn orders them; the high
  // arms answer for the whole turn (a mon that woke up does not then get
  // asked about flinching) and the low one falls through when it lets the
  // move go.
  const record = Battle.statusRecordFor(self.data, mon.status);
  let beforeMove = truthy(record) ? record!.beforeMove : undefined;
  if (truthy(beforeMove) && (record!.beforeMovePriority ?? 0) > Battle.VOLATILE_PRIORITY) {
    // engine/battle/effect_commands.asm:188-200
    const bypass = mon.status === "sleep" && Battle.SLEEP_BYPASS_MOVES[moveId as string];
    const acted = truthy(beforeMove!(self, mon, name));
    if (acted || !truthy(bypass)) return acted;
    beforeMove = undefined;
  }
  // SUBSTATUS_FLINCHED, read and cleared right after the freeze check
  // (CheckPlayerTurn / CheckEnemyTurn `.not_frozen`).  Set this turn by the
  // opponent's HELD_FLINCH item (King's Rock) -- and the EFFECT_FLINCH_HIT
  // moves once they write the same flag.
  if (truthy(vol.flinched)) {
    vol.flinched = undefined;
    self.emit({ kind: "message", text: Strings.get("%s flinched!", name) });
    return false;
  }
  // SUBSTATUS_CONFUSED (CheckPlayerTurn past `.not_flinched`): the count
  // decrements FIRST and zero snaps out -- the mon still acts that turn.
  // While it holds, one byte under 50 percent + 1 spends the turn on
  // HitConfusion's self-hit instead.
  if (truthy(vol.confuseCount)) {
    vol.confuseCount = vol.confuseCount - 1;
    if (vol.confuseCount <= 0) {
      vol.confuseCount = undefined;
      self.emit({ kind: "message", text: Strings.get("%s's confused no more!", name) });
    } else {
      self.emit({ kind: "message", text: Strings.get("%s is confused!", name) });
      if (rand(self.random, 256) < 128) {
        self.confusionSelfHit(mon);
        return false;
      }
    }
  }
  // engine/battle/effect_commands.asm:291-310, enemy twin :539-558
  if (truthy(vol.attract)) {
    const partner = mon === self.player ? self.enemy : self.player;
    // data/text/battle.asm:484
    self.emit({ kind: "message", text: Strings.get("%s\nis in love with", name) });
    self.emit({ kind: "message", text: Strings.get("is in love with\n%s!", self.monName(partner)) });
    if (rand(self.random, 256) >= 128) {
      // data/text/battle.asm:490
      self.emit({ kind: "message", text: Strings.get("%s's\ninfatuation kept", name) });
      self.emit({ kind: "message", text: Strings.get("infatuation kept\nit from attacking!") });
      return false;
    }
  }
  if (truthy(beforeMove)) {
    return truthy(beforeMove!(self, mon, name));
  }
  return true;
}

// A battle.damage chain may be a Gen 1 mod, which returns Gen 1's info table
// ({ crit, typeMult }) rather than Gen 2's ({ critical, effectiveness, ... }).
// The two names mean the same thing in both generations, so read either --
// src/battle/gen2/Damage.lua answers to both for the same reason.
// Lua: Battle.lua:1144
function normalizeDamageInfo(info: any): any {
  if (typeof info !== "object" || info === null) return info;
  if (info.critical == null && info.crit != null) info.critical = info.crit;
  if (info.effectiveness == null && info.typeMult != null) {
    info.effectiveness = info.typeMult;
  }
  return info;
}

export class Battle {
  [key: string]: any; // the battle is a Lua table: open instance state
  static [key: string]: any; // and open statics (parts B/C add constants)

  // Burn and poison both tick 1/8 of max HP at the end of a turn in Gen 2.
  // Lua: Battle.lua:54
  static BURN_FRACTION = 8;
  static POISON_FRACTION = 8;
  // Burn halves physical Attack; paralysis quarters Speed.
  static BURN_ATTACK_DIVISOR = 2;
  static PARALYSIS_SPEED_DIVISOR = 4;
  // A paralysed mon loses its turn a quarter of the time.
  static PARALYSIS_SKIP_CHANCE = 4;
  // A frozen mon thaws on a 1-in-5 roll each turn it tries to move.
  static THAW_CHANCE = 5;

  // Moves whose effect the engine models.  Everything else lands as a plain hit
  // (or, with no power, as a no-op message), which is honest: an unmodelled
  // effect never silently does the wrong thing.
  // Lua: Battle.lua:67
  static STATUS_EFFECTS: Record<string, string> = {
    EFFECT_SLEEP: "sleep",
    EFFECT_POISON: "poison",
    EFFECT_TOXIC: "toxic",
    EFFECT_PARALYZE: "paralyze",
    EFFECT_BURN: "burn",
    EFFECT_FREEZE: "freeze",
    EFFECT_CONFUSE: "confuse",
  };
  // Lua: Battle.lua:76
  static SECONDARY_EFFECTS: Record<string, string> = {
    EFFECT_POISON_HIT: "poison",
    EFFECT_BURN_HIT: "burn",
    EFFECT_FREEZE_HIT: "freeze",
    EFFECT_PARALYZE_HIT: "paralyze",
    EFFECT_SLEEP_HIT: "sleep",
    EFFECT_CONFUSE_HIT: "confuse",
    EFFECT_SACRED_FIRE: "burn", // data/moves/effects.asm:1696
  };

  // data/trainers/leaders.asm.  The two lists are ONE array in the ROM: only
  // KantoGymLeaders carries the -1 terminator, and GymLeaders falls through into
  // it, so IsGymLeader matches all twenty-two classes while IsKantoGymLeader
  // (which starts halfway down) matches the last eight.  Splitting them into two
  // separate tables here and forgetting the fallthrough would deny Brock's party
  // its HAPPINESS_GYMBATTLE, which is exactly the bug the comment at the top of
  // leaders.asm warns about.  (The fallthrough is folded in after the class.)
  // Lua: Battle.lua:114
  static KANTO_GYM_LEADER_CLASSES: Record<string, boolean> = {
    BROCK: true, MISTY: true, LT_SURGE: true, ERIKA: true,
    JANINE: true, SABRINA: true, BLAINE: true, BLUE: true,
  };
  // Lua: Battle.lua:118
  static GYM_LEADER_CLASSES: Record<string, boolean> = {
    FALKNER: true, WHITNEY: true, BUGSY: true, MORTY: true,
    PRYCE: true, JASMINE: true, CHUCK: true, CLAIR: true,
    WILL: true, BRUNO: true, KAREN: true, KOGA: true,
    CHAMPION: true, RED: true,
  };

  // IsGymLeader / IsKantoGymLeader, as predicates.
  // Lua: Battle.lua:129
  static isGymLeader(cls: string | null | undefined): boolean {
    return cls != null && Battle.GYM_LEADER_CLASSES[cls] === true;
  }

  // Lua: Battle.lua:133
  static isKantoGymLeader(cls: string | null | undefined): boolean {
    return cls != null && Battle.KANTO_GYM_LEADER_CLASSES[cls] === true;
  }

  // The four items XItemEffect covers (data/items/x_stats.asm).  DIRE_HIT and
  // GUARD_SPEC have their own effect routines and award nothing, so they are
  // deliberately not here.
  // Lua: Battle.lua:140
  static X_ITEMS: Record<string, boolean> = {
    X_ATTACK: true, X_DEFEND: true, X_SPEED: true, X_SPECIAL: true,
  };

  // data/items/x_stats.asm: which stat each X item raises one stage of.
  // X SPECIAL is SP_ATTACK only in Gen 2.
  // Lua: Battle.lua:146
  static X_ITEM_STATS: Record<string, string> = {
    X_ATTACK: "attack", X_DEFEND: "defense", X_SPEED: "speed",
    X_SPECIAL: "specialAttack",
  };

  // XAccuracyEffect / DireHitEffect / GuardSpecEffect (engine/items/
  // item_effects.asm:2079-2113): each sets one wPlayerSubStatus4 bit on the
  // active mon and refuses when it is already up.  The bits live in the mon's
  // volatile so a switch drops them, which is what SUBSTATUS4 does too.
  // Lua: Battle.lua:155
  static SUBSTATUS_ITEMS: Record<string, string> = {
    X_ACCURACY: "xAccuracy", // SUBSTATUS_X_ACCURACY: skip the accuracy roll
    DIRE_HIT: "focusEnergy", // SUBSTATUS_FOCUS_ENERGY: +1 critical level
    GUARD_SPEC: "mist", // SUBSTATUS_MIST: no stat drops from the foe
  };

  // constants/battle_constants.asm const order: the two battle types whose
  // whole meaning is "no escape".  TryToRunAwayFromBattle jumps straight to
  // .cant_escape for both, ahead of even the trainer check, and
  // BattleCommand_ForceSwitch fails outright for both -- the Lake of Rage
  // Gyarados (FORCESHINY) and the Rocket base's exploding traps (TRAP) cannot
  // be run from or Roared away.
  // Lua: Battle.lua:167
  static BATTLETYPE_FORCESHINY = 7;
  static BATTLETYPE_TRAP = 9;
  // ../pokecrystal/constants/battle_constants.asm:102-103, Crystal-only appends
  static BATTLETYPE_CELEBI = 11;
  static BATTLETYPE_SUICUNE = 12;
  // LostBattle's .canlose arm (engine/battle/core.asm:2766): the only battle
  // type whose loss still prints the trainer's own line instead of a whiteout.
  static BATTLETYPE_CANLOSE = 1;
  // ../pokecrystal/constants/battle_constants.asm:91-103
  static BATTLETYPE_NORMAL = 0;
  static BATTLETYPE_DEBUG = 2;
  static BATTLETYPE_TUTORIAL = 3;
  static BATTLETYPE_FISH = 4;
  static BATTLETYPE_ROAMING = 5;
  static BATTLETYPE_CONTEST = 6;
  static BATTLETYPE_TREE = 8;
  static BATTLETYPE_FORCEITEM = 10;

  // Lua: Battle.lua:201
  static battleTypeId(value: any): number | undefined {
    if (value == null) return undefined;
    if (typeof value === "string") {
      return BATTLETYPE_NAMES[value.toLowerCase()] ?? tonumber(value);
    }
    return value;
  }

  // BadgeStatBoosts (engine/battle/core.asm:6534): each of these Johto badges
  // raises the PLAYER's in-battle stat by 1/8.  The routine walks every other
  // badge bit after swapping PlainBadge and MineralBadge, which is what lands
  // Mineral on Defense and Plain on Speed; Glacier boosts Special Attack, and
  // its Special Defense re-check is the buggy tail modelled in
  // Battle.glacierBoostsSpDef below.
  // Lua: Battle.lua:215
  static BADGE_STAT_BOOSTS: Record<string, string> = {
    attack: "ZEPHYR",
    defense: "MINERAL",
    speed: "PLAIN",
    specialAttack: "GLACIER",
  };

  // data/types/badge_type_boosts.asm, in the cart's own walk order: the eight
  // wJohtoBadges bits, then the eight wKantoBadges bits.  DoBadgeTypeBoosts
  // boosts the player's damage by 1/8 when an owned badge's type matches the
  // move's.
  // Lua: Battle.lua:226
  static BADGE_TYPE_BOOSTS: { store: string; badge: string; type: string }[] = [
    { store: "badges", badge: "ZEPHYR", type: "FLYING" },
    { store: "badges", badge: "HIVE", type: "BUG" },
    { store: "badges", badge: "PLAIN", type: "NORMAL" },
    { store: "badges", badge: "FOG", type: "GHOST" },
    { store: "badges", badge: "MINERAL", type: "STEEL" },
    { store: "badges", badge: "STORM", type: "FIGHTING" },
    { store: "badges", badge: "GLACIER", type: "ICE" },
    { store: "badges", badge: "RISING", type: "DRAGON" },
    { store: "kantoBadges", badge: "BOULDER", type: "ROCK" },
    { store: "kantoBadges", badge: "CASCADE", type: "WATER" },
    { store: "kantoBadges", badge: "THUNDER", type: "ELECTRIC" },
    { store: "kantoBadges", badge: "RAINBOW", type: "GRASS" },
    { store: "kantoBadges", badge: "SOUL", type: "POISON" },
    { store: "kantoBadges", badge: "MARSH", type: "PSYCHIC_TYPE" },
    { store: "kantoBadges", badge: "VOLCANO", type: "FIRE" },
    { store: "kantoBadges", badge: "EARTH", type: "GROUND" },
  ];

  // wJohtoBadges bit order, for the positional keying FieldMoves.hasBadge also
  // accepts (a save may key player.badges by name or by bit position).
  // Lua: Battle.lua:247
  static JOHTO_BADGE_ORDER: string[] = [
    "ZEPHYR", "HIVE", "PLAIN", "FOG", "MINERAL", "STORM", "GLACIER", "RISING",
  ];
  static KANTO_BADGE_ORDER: string[] = [
    "BOULDER", "CASCADE", "THUNDER", "RAINBOW",
    "SOUL", "MARSH", "VOLCANO", "EARTH",
  ];

  // opts:
  //   data      { pokemon, moves, type_chart, items }
  //   party     the player's party (array of Mon)
  //   wild      a single Mon for a wild battle
  //   trainer   { class, name, party, baseMoney } for a trainer battle;
  //             baseMoney is the class's TRNATTR_BASE_REWARD and is what
  //             src/battle/gen2/Prize.lua pays out of when the trainer loses
  //   save      the Gold save, for the two money accounts WinTrainerBattle
  //             writes.  Optional: a headless turn-order test hands in no save
  //             and the payout is simply skipped, the way wMoney is untouched
  //             by a link battle
  //   roaming   the save's roamer slot index (1 Raikou, 2 Entei, 3 Suicune) when
  //             this wild battle is BATTLETYPE_ROAMING; the caller built `wild`
  //             through Roamers.beginBattle and reads Battle.roaming back to
  //             bank the beast's HP afterwards
  //   random(n) 0..n-1, injected so a test is deterministic (BattleRandom)
  //   rng(lo,hi) / rng(n) Gen 1 / love.math contract; defaults over `random`
  // Lua: Battle.lua:272
  static new(opts?: Record<string, any> | null): Battle {
    opts = opts ?? {};
    const self = new Battle();
    self.data = opts.data ?? {};
    self.random = opts.random ?? ((n: number) => rand(undefined, n));
    // Same stream as `random`, Gen 1 / love.math calling convention.
    self.rng = opts.rng ?? loveStyleRng(self.random);
    self.party = opts.party ?? [];
    self.trainer = opts.trainer;
    self.save = opts.save;
    // wBattleType, when the caller knows it: "fish" gates the Lure Ball's x3
    // (BATTLETYPE_FISH is the one condition LureBallMultiplier reads), and the
    // FORCESHINY / TRAP no-escape rules will hang off the same field.
    self.battleType = Battle.battleTypeId(opts.battleType);
    // wInBattleTowerBattle (../pokecrystal/constants/ram_constants.asm:38), set
    // around the Tower's own StartBattle (engine/events/battle_tower/
    // battle_tower.asm:220-223) and cleared again at :253-254.
    self.inBattleTowerBattle = truthy(opts.battleTower);
    // wTimeOfDay: only BattleCommand_TimeBasedHealContinue reads it in battle
    // (engine/battle/effect_commands.asm:6401-6404).
    self.timeOfDay = opts.timeOfDay;
    self.events = [];
    self.turn = 0;
    self.over = false;
    self.outcome = undefined; // "win" | "lose" | "run" | "caught"
    // Participants earn experience; a switch adds to the set.  Keyed by the
    // 1-based party slot.
    self.participants = {};

    self.playerIndex = Battle.firstHealthy(self.party) ?? 1;
    self.player = self.party[self.playerIndex - 1];
    if (truthy(self.player)) self.participants[self.playerIndex] = true;
    // wAmuletCoin, latched by CheckAmuletCoin on every send-out and never
    // cleared again until the next battle starts.
    self.amuletCoin = false;
    self.checkAmuletCoin(self.player);

    if (truthy(opts.wild)) {
      self.wild = true;
      self.enemy = opts.wild;
      self.enemyParty = [opts.wild];
      self.enemyIndex = 1;
      // wBattleType = BATTLETYPE_ROAMING.  Kept as the SLOT index rather than a
      // boolean because BattleEnd_HandleRoamMons needs to know whose HP byte to
      // write, and GetRoamMonHP resolves that from the species.
      self.roaming = opts.roaming;
    } else {
      self.wild = false;
      self.enemyParty = (truthy(self.trainer) && self.trainer.party) || [];
      // trainer.party, the same hook BattleState:startTrainer calls on Gen 1 and
      // with the same three arguments: the class, which roster of that class, and
      // the roster itself, returning the roster to fight.  The second argument is
      // the party MEMBER id (RIVAL2_2_CHIKORITA), which is what picks a roster
      // out of a class in Gen 2 -- Gen 1's numeric index by another name.
      if (truthy(self.trainer) && Runtime.wantsHook("trainer.party")) {
        self.enemyParty = Runtime.call("trainer.party", (_c: any, _m: any, party: any) => party,
          self.trainer.classId ?? self.trainer.class,
          self.trainer.memberId ?? self.trainer.index ?? 1,
          self.enemyParty) || self.enemyParty;
      }
      self.enemyIndex = Battle.firstHealthy(self.enemyParty) ?? 1;
      self.enemy = self.enemyParty[self.enemyIndex - 1];
    }

    for (const mon of self.party) {
      Mon.refreshStats(mon, self.data);
    }
    for (const mon of self.enemyParty ?? []) {
      Mon.refreshStats(mon, self.data);
    }

    // Battle RAM opens empty on both sides: NewBattleMonStatus and
    // NewEnemyMonStatus run at the first send-out of every battle.
    self.clearAllVolatiles();

    self.stages = {
      player: Battle.newStages(),
      enemy: Battle.newStages(),
    };
    // wBattleWeather / wWeatherCount: field state, not per-mon, so it survives a
    // switch on either side.
    self.weather = undefined;
    self.weatherTurns = 0;
    // wPlayerScreens / wEnemyScreens SCREENS_SPIKES: laid on the side that will
    // be switching INTO them.
    self.spikes = { player: false, enemy: false };
    // The other two wPlayerScreens bits, with their five-turn counts
    // (BattleCommand_Screen / HandleScreens): SIDE state like the spikes, so
    // a switch does not take a screen down.
    self.screens = { player: {}, enemy: {} };

    // The side substrate Gen 1's battle carries (src/battle/BattleState.lua's
    // own self.sides): index 1 is the player's side, index 2 the foe's, and the
    // engine writes nothing into screens/hazards/tokens -- they are the stable
    // shape mods hang their own state on.  `battlers[1]` is kept current by
    // Battle:syncSides.
    self.sides = Battle.newSides();

    // InitEnemyTrainer's tail: a Gym Leader (or an Elite Four member, or the
    // Champion, or Red -- IsGymLeader's list is longer than its name) raises the
    // happiness of every party mon still standing, BEFORE the first turn.  You
    // are paid for showing up, not for winning.
    if (truthy(self.trainer) && Battle.isGymLeader(self.trainer.class)) {
      Happiness.changeParty(self.party, "GYMBATTLE");
    }
    // battle.started, the payload BattleState:enter emits on Gen 1: `kind` is the
    // battle's shape, `trainerId` the class the fight is against (nil for a wild
    // one), and `species` / `level` the mon standing opposite.
    Runtime.emit("battle.started", {
      battle: self, kind: self.wild ? "wild" : "trainer",
      trainerId: truthy(self.trainer)
        ? orNil(self.trainer.classId ?? self.trainer.class) : undefined,
      species: truthy(self.enemy) ? self.enemy.species : self.enemy,
      level: truthy(self.enemy) ? self.enemy.level : self.enemy,
      // Gen 2 additions: the wBattleType byte (BATTLETYPE_FORCESHINY and friends,
      // or "fish"), and the roster this trainer brought, held items and all.
      battleType: self.battleType,
      trainer: self.trainer,
    });
    return self;
  }

  // The side substrate, kept next to the stage table it sits beside in the
  // constructor.  Built lazily by Battle:syncSides as well, so a caller that
  // assembles a battle by hand still gets the shape battle.battler_switched
  // reports.
  // Lua: Battle.lua:404
  static newSides(): Record<string, any>[] {
    return [
      { index: 1, key: "player", battlers: [], screens: {}, hazards: {}, tokens: {} },
      { index: 2, key: "enemy", battlers: [], screens: {}, hazards: {}, tokens: {} },
    ];
  }

  // Lua: Battle.lua:413
  static newStages(): Record<string, number> {
    return {
      attack: 0, defense: 0, speed: 0,
      specialAttack: 0, specialDefense: 0,
      accuracy: 0, evasion: 0,
    };
  }

  // The first party member that can actually FIGHT (its 1-based slot).
  //
  // An EGG has HP and is not fainted, and nothing here used to exclude it -- so
  // carrying the Togepi egg meant it counted as a battler: the wipe check never
  // fired while the egg was intact, and the game asked you to send an egg out
  // against Morty.  The cart cannot: CheckCurPartyMon and the switch menu both
  // refuse an egg, and `wPartyCount` minus the eggs is what decides a whiteout.
  // Lua: Battle.lua:430
  static firstHealthy(party: BattleMon[] | null | undefined): number | undefined {
    const list = party ?? [];
    for (let i = 0; i < list.length; i++) {
      const mon = list[i];
      if (!truthy(mon.isEgg) && (mon.hp ?? 0) > 0) return i + 1;
    }
    return undefined;
  }

  // Lua: Battle.lua:437
  emit(event: Record<string, any>): Record<string, any> {
    this.events.push(event);
    return event;
  }

  // Drain the event queue; the screen calls this each time it finishes showing
  // what it already had.
  // Lua: Battle.lua:444
  takeEvents(): Record<string, any>[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // The one place a battle is decided, so battle.ended is raised exactly once
  // however many times the faint sweep runs over an already-finished battle.
  // Gen 1's payload is { battle, result }; `result` here is the same string
  // Battle.outcome carries, with Gen 2's own two extra outcomes ("fled" for
  // WildFled_EnemyFled, "draw" for a Bug Contest that ran out of balls) beside
  // Gen 1's win / lose / run / caught.
  // Lua: Battle.lua:456
  endBattle(outcome: string | undefined): void {
    this.over = true;
    this.outcome = outcome;
    // Whoever is still standing leaves the battle as itself: the copy Transform
    // wrote is battle ram on the cart and CleanUpBattleRAM takes it.  A caller
    // that ends a battle without a screen has to leave the party clean too --
    // Battle.party IS save.party.
    this.pinIdentity(this.player);
    this.pinIdentity(this.enemy);
    this.untransform(this.player);
    this.untransform(this.enemy);
    if (truthy(this.endedEmitted)) return;
    this.endedEmitted = true;
    Runtime.emit("battle.ended", { battle: this, result: outcome });
  }

  // Never-nil BattleRandom (0..n-1) for call sites that want the cart byte.
  // `battle.rng` is the Gen 1 / love.math view of the same stream.
  // Lua: Battle.lua:475
  roller(): ZeroRandom {
    if (!truthy(this.rollerFn)) {
      this.rollerFn = (n: number) => rand(this.random, n);
    }
    return this.rollerFn;
  }

  // Lua: Battle.lua:482
  sideOf(mon: BattleMon): "player" | "enemy" {
    return mon === this.player ? "player" : "enemy";
  }

  // Point each side record at whoever is standing on it, the way Gen 1's
  // BattleState:syncSides does.
  // Lua: Battle.lua:488
  syncSides(): void {
    this.sides = this.sides ?? Battle.newSides();
    this.sides[0].battlers[0] = this.player;
    this.sides[1].battlers[0] = this.enemy;
  }

  // The side RECORD a mon is on (Gen 1's payload shape) rather than the string
  // key the Gen 2 engine indexes its own tables with.
  // Lua: Battle.lua:496
  sideRecord(mon: BattleMon): Record<string, any> {
    this.syncSides();
    return mon === this.player ? this.sides[0] : this.sides[1];
  }

  // Lua: Battle.lua:501
  monName(mon: BattleMon): string {
    if (!truthy(mon)) return "?";
    return mon.nickname ?? mon.name ?? mon.species ?? "?";
  }

  // ../pokecrystal/data/text/battle.asm:240-246
  // Lua: Battle.lua:507
  static sentOutText(trainerName: string, monName: string): string {
    return Strings.get("%s\nsent out\v%s!", trainerName, monName);
  }

  // Lua: Battle.lua:511
  moveDef(moveId: string | undefined): any {
    return truthy(this.data.moves) ? orNil(this.data.moves[moveId as string]) : undefined;
  }

  // The board as AI_Smart reads it.  CheckPlayerMoveTypeMatchups
  // (engine/battle/ai/switch.asm).  wEnemyAISwitchScore starts at
  // BASE_AI_SWITCH_SCORE and walks down one for every super-effective move the
  // player has ACTUALLY shown against whatever the AI has out; below that base
  // means the player is winning the type war.  Both the switch layer and four
  // AI_Smart handlers (ForceSwitch, BatonPass, PerishSong, MeanLook) read this
  // one number, so it lives in one place and the two cannot drift apart.
  // Lua: Battle.lua:524
  playerMatchupScore(): number {
    let score: number = Ai.BASE_SWITCH_SCORE;
    const enemyTypes = this.battleTypes(this.enemy);
    const matchups = truthy(this.data.type_chart) ? this.data.type_chart.matchups : undefined;
    for (const id of this.volatile(this.player).usedMoves ?? []) {
      const def = this.moveDef(id);
      if (truthy(def) && (def.power ?? 0) > 0
          && Damage.typeMultiplier(def.type, enemyTypes, matchups) > 10) {
        score = score - 1;
      }
    }
    return score;
  }

  // engine/battle/hidden_power.asm's type table, as the sixteen values
  // (Atk & 3) * 4 + (Def & 3) can take.  The routine's `inc a` past NORMAL, its
  // second `inc a` past BIRD and its `add UNUSED_TYPES_END - UNUSED_TYPES`
  // collapse to exactly this list, in this order.
  // Lua: Battle.lua:543
  static HIDDEN_POWER_TYPES: string[] = [
    "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL",
    "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC_TYPE", "ICE", "DRAGON", "DARK",
  ];

  // HiddenPowerDamage: Hidden Power's real base power (31..70) and type come from
  // the user's DVs, not from the move table's stub.  Returns [nil, nil] when the
  // mon carries no DVs to read.
  //
  // The power byte takes the TOP bit of each of the four DVs (`and %1000`), NOT
  // the low bits Mon.hpDV builds the HP DV out of, so this cannot borrow that
  // helper.
  // Lua: Battle.lua:556
  hiddenPower(mon: BattleMon): [number | undefined, string | undefined] {
    const dvs = truthy(mon) ? mon.dvs : undefined;
    if (!truthy(dvs)) return [undefined, undefined];
    const high = (value: number | undefined): number => mod(idiv(value ?? 0, 8), 2);
    const bits = high(dvs.attack) * 8 + high(dvs.defense) * 4
      + high(dvs.speed) * 2 + high(dvs.special);
    const power = idiv(bits * 5 + mod(dvs.special ?? 0, 4), 2) + 31;
    const index = mod(dvs.attack ?? 0, 4) * 4 + mod(dvs.defense ?? 0, 4);
    return [power, Battle.HIDDEN_POWER_TYPES[index]];
  }

  // Everything the AI_Smart layer reads, gathered once per enemy decision.  A
  // field the engine cannot answer honestly is simply left nil, and the matching
  // handler branch never fires: see the "read but never produced" list in Ai.lua.
  // Lua: Battle.lua:570
  smartAiState(): Record<string, any> {
    const enemyState = this.volatile(this.enemy);
    const playerState = this.volatile(this.player);
    const chart = this.data.type_chart;
    const typeTable = truthy(chart) ? chart.types : undefined;
    const matchups = truthy(chart) ? chart.matchups : undefined;

    // AIHasMoveEffect walks the enemy's list by effect; AIHasMoveInArray (the
    // weather moves) matches raw move IDS, so both shapes are built here.
    const known: Record<string, boolean> = {};
    const ids: Record<string, boolean> = {};
    for (const move of this.enemy.moves ?? []) {
      const def = this.moveDef(move.id);
      if (truthy(def) && truthy(def.effect)) known[def.effect] = true;
      ids[move.id] = true;
    }

    // wPlayerUsedMoves, read three ways: AI_Smart_Counter counts the physical
    // damaging entries, AI_Smart_MirrorCoat the special ones, and
    // AI_Smart_RazorWind wants the EFFECTS behind them (it dismisses itself on
    // EFFECT_PROTECT).
    let physical = 0;
    let special = 0;
    const usedEffects: Record<string, boolean> = {};
    for (const id of playerState.usedMoves ?? []) {
      const def = this.moveDef(id);
      if (truthy(def)) {
        if (truthy(def.effect)) usedEffects[def.effect] = true;
        if ((def.power ?? 0) > 0) {
          if (Damage.isPhysical(def.type, typeTable)) {
            physical = physical + 1;
          } else {
            special = special + 1;
          }
        }
      }
    }

    const enemyTypes = this.battleTypes(this.enemy);
    const playerTypes = this.battleTypes(this.player);
    // `cp SPECIAL` against wBattleMonType1/2: AI_Smart_SpDefenseUp2 and
    // AI_Smart_Curse ask the same question, "is EITHER player type special".
    // nil rather than false when the types are unknown, so the branch stays shut.
    let playerSpecialType: boolean | undefined;
    for (const name of playerTypes) {
      if (!Damage.isPhysical(name, typeTable)) playerSpecialType = true;
    }

    // The player's own ramp.  The port keeps ONE counter pair for Rollout and
    // Fury Cutter, so the loaded move is what tells wPlayerFuryCutterCount from
    // SUBSTATUS_ROLLOUT apart.
    const rampDef = truthy(playerState.rampMove) ? this.moveDef(playerState.rampMove) : undefined;
    const rampEffect = truthy(rampDef) ? rampDef.effect : undefined;

    // wLastPlayerCounterMove: what Spite drains, what Mimic would copy (the cart
    // sets hBattleTurn to 1, so the matchup defends with the PLAYER's own types)
    // and what Mirror Coat's tail tests.
    const lastId = playerState.lastMove;
    const lastDef = truthy(lastId) ? this.moveDef(lastId) : undefined;
    const lastEntry = truthy(lastId) ? this.findMove(this.player, lastId) : undefined;

    // AI_Smart_LockOn's `.checkmove`: a move worth aiming, meaning one under
    // `71 percent - 1` ($b4) raw accuracy whose type is at least neutral against
    // the player.  Explicitly false when the loop found nothing, since that is
    // the case the cart discourages on.
    let aimable = false;
    for (const move of this.enemy.moves ?? []) {
      const def = this.moveDef(move.id);
      if (truthy(def) && (def.accuracyRaw ?? 255) < 0xb4
          && Damage.typeMultiplier(def.type, playerTypes, matchups) >= 10) {
        aimable = true;
      }
    }

    // AI_Smart_HealBell ORs the status byte of every unfainted mon in wOTParty,
    // the active one included.
    let partyStatus = false;
    for (const mon of this.enemyParty ?? []) {
      if ((mon.hp ?? 0) > 0 && truthy(mon.status)) partyStatus = true;
    }

    // FindAliveEnemyMons and AICheckLastPlayerMon: both skip the mon that is out
    // and ask whether anything is left behind it.
    let enemyHasBench = false;
    (this.enemyParty ?? []).forEach((mon: BattleMon, i: number) => {
      if (i + 1 !== this.enemyIndex && (mon.hp ?? 0) > 0) {
        enemyHasBench = true;
      }
    });
    let playerLastMon = true;
    (this.party ?? []).forEach((mon: BattleMon, i: number) => {
      if (i + 1 !== this.playerIndex && (mon.hp ?? 0) > 0) {
        playerLastMon = false;
      }
    });

    const [hiddenPowerPower, hiddenPowerType] = this.hiddenPower(this.enemy);

    return {
      enemyHp: this.enemy.hp,
      enemyMaxHp: this.enemy.maxHp ?? (this.enemy.stats ?? {}).hp,
      playerHp: this.player.hp,
      playerMaxHp: this.player.maxHp ?? (this.player.stats ?? {}).hp,
      enemyLevel: this.enemy.level, playerLevel: this.player.level,
      enemyFaster: this.effectiveSpeed(this.enemy)
        > this.effectiveSpeed(this.player),
      enemyStatus: this.enemy.status, playerStatus: this.player.status,
      enemyTurns: enemyState.turnsTaken ?? 0,
      playerTurns: playerState.turnsTaken ?? 0,
      stages: this.stages.enemy, playerStages: this.stages.player,
      playerToxic: this.player.status === "toxic",
      playerLeechSeed: playerState.leechSeed,
      playerCharged: playerState.chargeMove != null,
      playerFlying: playerState.vanished,
      playerLastMove: lastId,
      // wPlayerSubStatus5 & SUBSTATUS_LOCK_ON: the enemy's OWN Lock-On, since
      // BattleCommand_LockOn sets the bit on the target it was aimed at.
      playerLockOn: orNil(playerState.lockOn),
      playerIdentified: orNil(playerState.identified),
      playerPhysicalMoves: physical,
      enemyRage: enemyState.rage,
      enemyRageCount: enemyState.rageCount,
      enemyProtectCount: enemyState.protectCount,
      enemyFuryCutterCount: enemyState.rampCount,
      enemyConfused: enemyState.confuseCount != null,
      // wPlayerWrapCount and SUBSTATUS_CURSE, live now that the trap and
      // curse volatiles are modelled.
      playerTrapped: ((playerState.wrapCount ?? 0) > 0) || undefined,
      playerCursed: orNil(playerState.cursed),
      knownEffects: known,
      enemyMoveIds: ids,

      // Types, IN SLOT ORDER: the weather handlers read slot 1 before slot 2 and
      // a swapped pair scores differently, so this is never sorted.
      enemyTypes,
      playerTypes,
      playerSpecialType,

      playerMatchupScore: this.playerMatchupScore(),
      playerSpecialMoves: special,
      playerUsedEffects: usedEffects,

      // SUBSTATUS_FLYING and SUBSTATUS_UNDERGROUND split apart.  Both Fly and Dig
      // carry EFFECT_FLY in Gen 2, so the vanish flag alone is ambiguous and the
      // stored move is what separates them; playerFlying above stays the combined
      // mask AI_Smart_Fly and AI_Smart_FutureSight want.
      playerFlyingUp: (truthy(playerState.vanished)
        && playerState.chargeMove === "FLY") || undefined,
      playerUnderground: (truthy(playerState.vanished)
        && playerState.chargeMove === "DIG") || undefined,

      playerFuryCutter: rampEffect === "EFFECT_FURY_CUTTER"
        ? (playerState.rampCount ?? 0) : undefined,
      playerRollout: (rampEffect === "EFFECT_ROLLOUT") || undefined,

      playerLastMovePp: truthy(lastEntry) ? orNil(lastEntry.pp) : undefined,
      playerLastMoveMatchup: truthy(lastDef)
        ? Damage.typeMultiplier(lastDef.type, playerTypes, matchups) : undefined,
      playerLastMoveSpecial: (lastDef != null
        && !Damage.isPhysical(lastDef.type, typeTable)) || undefined,
      playerLastMon,

      enemyToxic: this.enemy.status === "toxic",
      enemyLeechSeed: enemyState.leechSeed,
      enemySpikes: truthy(this.spikes) ? orNil(this.spikes.enemy) : undefined,
      enemyPerishCount: enemyState.perish,
      // wEnemyMonStatus & SLP_MASK, on the cart's own scale: Battle:canAct
      // decrements statusTurns and clears the status at zero, so a value of 1 is
      // exactly the `cp 1` last sleeping turn.  Always a number, never nil, or
      // AI_Smart_Snore scores nothing at all.
      enemySleepTurns: this.enemy.status === "sleep"
        ? (this.enemy.statusTurns ?? 0) : 0,
      enemyPartyStatus: partyStatus,
      enemyHasBench,
      enemyInaccurateEffectiveMove: aimable,

      hiddenPowerPower,
      hiddenPowerMatchup: truthy(hiddenPowerType)
        ? Damage.typeMultiplier(hiddenPowerType, playerTypes, matchups) : undefined,

      weather: this.weather,
    };
  }

  // Every move id the cache knows, for Metronome.  Sorted so the pick is
  // reproducible from a seeded roll rather than from Lua's hash order.
  // Lua: Battle.lua:756
  moveOrder(): string[] {
    if (truthy(this._moveOrder)) return this._moveOrder;
    const out: string[] = [];
    const moves = this.data.moves ?? {};
    for (const id of Object.keys(moves)) {
      const def = moves[id];
      if (typeof def === "object" && def !== null && def.power != null) out.push(id);
    }
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this._moveOrder = out;
    return out;
  }

  // Lua: Battle.lua:767
  speciesDef(mon: BattleMon): any {
    return truthy(mon) && truthy(this.data.pokemon)
      ? orNil(this.data.pokemon[mon.species]) : undefined;
  }

  // A battler's two types as the battle sees them: CONVERSION and
  // CONVERSION2 write both type bytes of the BATTLE struct
  // (move_effects/conversion.asm, conversion2.asm), which the next switch
  // reloads from the party -- so the override sits in the volatile and goes
  // with it.  Otherwise the species' types (a Transform swaps the species).
  battleTypes(mon: BattleMon): string[] {
    const override = truthy(mon) && truthy(mon.volatile) ? mon.volatile.typeOverride : undefined;
    if (truthy(override)) return override;
    return (this.speciesDef(mon) ?? {}).types ?? (truthy(mon) ? mon.types : undefined) ?? [];
  }

  // One badge, read the way FieldMoves.hasBadge reads it: save.player.badges /
  // save.player.kantoBadges keyed by name, with the bit position accepted as a
  // fallback key so the two readers cannot disagree about who owns what.  (A
  // positional store is a 0-based JS array here, as a Lua sequence becomes.)
  // Lua: Battle.lua:774
  hasBadge(store: string, badge: string): boolean {
    const player = truthy(this.save) ? this.save.player : undefined;
    const owned = truthy(player) ? player[store] : undefined;
    if (typeof owned !== "object" || owned === null) return false;
    if (truthy(owned[badge])) return true;
    const order = store === "kantoBadges" ? Battle.KANTO_BADGE_ORDER
      : Battle.JOHTO_BADGE_ORDER;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === badge) return owned[i] === true;
    }
    return false;
  }

  // BoostStat (engine/battle/core.asm:6590): raise a stat by 1/8, capped at
  // MAX_STAT_VALUE (999).  The eighth is a plain shift, so a stat under 8
  // gains nothing.
  // Lua: Battle.lua:790
  static boostStat(value: number): number {
    return Math.min(999, value + idiv(value, 8));
  }

  // BadgeStatBoosts' buggy tail: the Special Defense re-check does `srl a`
  // assuming `a` still holds the badge bits, but when GlacierBadge fired for
  // Special Attack the preceding BoostStat overwrote `a` with its cap-check
  // arithmetic.  So with Glacier owned, whether SpDef is ALSO boosted depends
  // on the boosted Special Attack value:
  //   * at or past the 999 cap, `a` leaves as LOW(999) = $e7, odd: boosted
  //   * otherwise `a` is high(v) - 3 - borrow, where the borrow is set when
  //     low(v) < LOW(999); the shifted-out low bit decides
  // (pokegold's own comment at core.asm:6584 marks the check buggy.)
  // Lua: Battle.lua:803
  static glacierBoostsSpDef(boostedSpAtk: number | undefined): boolean {
    const v = boostedSpAtk ?? 0;
    if (v >= 999) return true;
    const borrow = mod(v, 256) < 231 ? 1 : 0;
    const a = mod(idiv(v, 256) - 3 - borrow, 256);
    return mod(a, 2) === 1;
  }

  // The stat a hit actually reads: the party stat, plus the player-side badge
  // boost.  BadgeStatBoosts runs against wBattleMon (the PLAYER's active mon
  // only, never the enemy and never in link), so the boost is applied here at
  // read time rather than mutating mon.stats, which IS the party slot in this
  // port and must survive the battle unboosted.
  // Lua: Battle.lua:816
  battleStat(mon: BattleMon, key: string): number {
    const value: number = (mon.stats ?? {})[key] ?? 1;
    if (mon !== this.player) return value;
    // BadgeStatBoosts' second early return (engine/battle/core.asm:6786-6788):
    // adventure badges do not follow the player into the standardised Tower.
    if (truthy(this.inBattleTowerBattle)) return value;
    const badge = Battle.BADGE_STAT_BOOSTS[key];
    if (truthy(badge) && this.hasBadge("badges", badge!)) {
      return Battle.boostStat(value);
    }
    if (key === "specialDefense" && this.hasBadge("badges", "GLACIER")) {
      const spAtk = Battle.boostStat((mon.stats ?? {}).specialAttack ?? 1);
      if (Battle.glacierBoostsSpDef(spAtk)) {
        return Battle.boostStat(value);
      }
    }
    return value;
  }

  // DoBadgeTypeBoosts (engine/battle/misc.asm:146): player's turn only, and
  // the first owned badge whose BadgeTypeBoosts row matches the move's type
  // boosts the damage.  Each type appears once, so this is a plain scan.
  // Lua: Battle.lua:838
  badgeTypeBoost(attacker: BattleMon, moveType: string | undefined): boolean {
    if (attacker !== this.player || !truthy(moveType)) return false;
    // DoBadgeTypeBoosts' own tower guard (engine/battle/misc.asm:152-154).
    if (truthy(this.inBattleTowerBattle)) return false;
    for (const row of Battle.BADGE_TYPE_BOOSTS) {
      if (row.type === moveType) {
        return this.hasBadge(row.store, row.badge);
      }
    }
    return false;
  }

  // The screen guarding this defender against this KIND of hit, the way
  // DamageStats consults wEnemyScreens/wPlayerScreens: Reflect doubles the
  // defending side's Defense against a physical move, Light Screen its
  // Special Defense against a special one.
  // Lua: Battle.lua:854
  screenActive(defender: BattleMon, physical: boolean): boolean {
    const side = truthy(this.screens) ? this.screens[this.sideOf(defender)] : undefined;
    if (!truthy(side)) return false;
    const turns = truthy(physical) ? (side.reflect ?? 0) : (side.lightScreen ?? 0);
    return turns > 0;
  }

  // GetUserItem's b/c pair: the held effect id and its parameter out of
  // ItemAttributes, or nil/0 for an empty hand.  Returns [effect, parameter].
  //
  // held_item.trigger, the most load-bearing of the names Gen 2 invents: Gen 1
  // has no held items at all, so there is no name to share.  It wraps this
  // function rather than each of the eight places an item acts, because on the
  // cart those eight places are all one routine -- and `trigger` says which
  // comparison is about to happen:
  //
  //   "priority"  DetermineMoveOrder's .equal_priority (Quick Claw)
  //   "damage"    DamageCalc's crit ladder and .DoneItem type boost (Scope Lens,
  //               the HELD_<TYPE>_BOOST family)
  //   "endure"    the 1 HP clamp (Focus Band)
  //   "flinch"    the post-hit flinch roll (King's Rock)
  //   "accuracy"  BattleCommand_CheckHit's .BrightPowder
  //   "confuse"   the confusion gate (HELD_PREVENT_CONFUSE)
  //   "residual"  Battle:tickHeldItem, the end-of-turn Leftovers/Berry/cure arm
  //   "check"     any other read; nothing in the engine passes this today
  //
  // Vanilla answers `ctx.effect, ctx.parameter`.  A returned effect that is not
  // a string is read as "no effect"; the parameter falls back to the item's own
  // rather than to 0, because 0 is a meaningful parameter (a 0% BrightPowder).
  // Lua: Battle.lua:890
  heldEffect(mon: BattleMon, trigger?: string): [string | undefined, number] {
    const def = this.itemDef(truthy(mon) ? mon.item : mon);
    const effect: string | undefined = truthy(def) ? orNil(def.heldEffect) : undefined;
    const parameter: number = (truthy(def) && truthy(def.heldParameter)) ? def.heldParameter : 0;
    if (!Runtime.wantsHook("held_item.trigger")) return [effect, parameter];
    const [hookedEffect, hookedParameter] = Runtime.call("held_item.trigger",
      (c: any): [any, any] => [c.effect, c.parameter],
      { battle: this, mon, item: truthy(mon) ? mon.item : mon, def,
        effect, parameter, trigger: trigger ?? "check" });
    if (typeof hookedEffect !== "string") return [undefined, 0];
    return [hookedEffect, tonumber(hookedParameter) ?? parameter];
  }

  // Effective Speed for ordering: stat stages, then the paralysis quarter.
  // Lua: Battle.lua:904
  effectiveSpeed(mon: BattleMon): number {
    const stages = this.stages[this.sideOf(mon)];
    const speed = Damage.applyStage(this.battleStat(mon, "speed"), stages.speed);
    return Battle.statusPenaltyFor(this.data, mon, "speed", speed);
  }

  // DetermineMoveOrder: faster side first, a coin flip on a tie.  Priority comes
  // from the move (Quick Attack and friends) and beats Speed outright.
  // Lua: Battle.lua:912
  orderOf(playerMove: string | undefined, enemyMove: string | undefined): "player" | "enemy" {
    const playerPriority = this.movePriority(playerMove);
    const enemyPriority = this.movePriority(enemyMove);
    if (playerPriority !== enemyPriority) {
      return playerPriority > enemyPriority ? "player" : "enemy";
    }
    // HELD_QUICK_CLAW (engine/battle/core.asm `.equal_priority`): consulted
    // only once priority ties, ahead of the Speed compare.  One byte against
    // the item's parameter (60 -> 60/256).  When both sides hold one the
    // ENEMY's roll goes first, exactly as the non-link `.both_have_quick_claw`
    // arm orders them.
    const [playerEffect, playerParam] = this.heldEffect(this.player, "priority");
    const [enemyEffect, enemyParam] = this.heldEffect(this.enemy, "priority");
    const playerClaw = playerEffect === "HELD_QUICK_CLAW";
    const enemyClaw = enemyEffect === "HELD_QUICK_CLAW";
    if (playerClaw && enemyClaw) {
      if (truthy(this.mirrored)) {
        if (rand(this.random, 256) < playerParam) return "player";
        if (rand(this.random, 256) < enemyParam) return "enemy";
      } else {
        if (rand(this.random, 256) < enemyParam) return "enemy";
        if (rand(this.random, 256) < playerParam) return "player";
      }
    } else if (playerClaw) {
      if (rand(this.random, 256) < playerParam) return "player";
    } else if (enemyClaw) {
      if (rand(this.random, 256) < enemyParam) return "enemy";
    }
    const playerSpeed = this.effectiveSpeed(this.player);
    const enemySpeed = this.effectiveSpeed(this.enemy);
    if (playerSpeed !== enemySpeed) {
      return playerSpeed > enemySpeed ? "player" : "enemy";
    }
    let playerFirst = rand(this.random, 2) === 0;
    if (truthy(this.mirrored)) playerFirst = !playerFirst;
    return playerFirst ? "player" : "enemy";
  }

  // Gen 2 priority moves.  data/moves/effects_priorities.asm keys off the move
  // *effect*, so a modded move inherits the priority of whatever it copies.
  // Lua: Battle.lua:952
  static PRIORITY: Record<string, number> = {
    EFFECT_PRIORITY_HIT: 1, // Quick Attack, Mach Punch
    EFFECT_PROTECT: 3,
    EFFECT_ENDURE: 3,
    EFFECT_COUNTER: -1,
    EFFECT_MIRROR_COAT: -1,
    EFFECT_FORCE_SWITCH: -1, // Whirlwind, Roar: priority 0, below BASE
  };

  // Lua: Battle.lua:961
  movePriority(moveId: string | undefined): number {
    // GetMovePriority `cp VITAL_THROW / ld a, 0 / ret z`
    // (engine/battle/core.asm:787-789).
    if (moveId === "VITAL_THROW") return -1;
    const def = this.moveDef(moveId);
    return (truthy(def) ? Battle.PRIORITY[def.effect] : undefined) ?? 0;
  }

  // engine/battle/effect_commands.asm:192-197 (enemy twin :383-390)
  // Lua: Battle.lua:970
  static SLEEP_BYPASS_MOVES: Record<string, boolean> = { SNORE: true, SLEEP_TALK: true };

  // CantMove (engine/battle/effect_commands.asm:344-353) clears BIDE on every
  // arm of CheckPlayerTurn / CheckEnemyTurn that spends the turn.
  // Lua: Battle.lua:1057
  canAct(mon: BattleMon, moveId?: string): boolean {
    const acted = checkTurn(this, mon, moveId);
    if (!acted) clearBide(this.volatile(mon));
    return acted;
  }

  // STRUGGLE, the move a mon with nothing left to spend falls back to
  // (engine/battle/core.asm `.CheckPlayerHasUsableMoves` for the player and
  // `.struggle` for the enemy).  It lives in the move table like any other move
  // -- typeless-in-practice NORMAL, 50 power, EFFECT_RECOIL_HIT -- and is
  // deliberately NOT in anyone's move list, which is why useMove's PP guard is
  // written `if move and ...`: findMove returns nil for it and the guard is
  // skipped rather than tripped.
  // Lua: Battle.lua:1070
  static STRUGGLE = "STRUGGLE";

  // .LockOn's three exceptions against a flying target
  // (engine/battle/effect_commands.asm:1683-1688).
  // Lua: Battle.lua:1074
  static LOCK_ON_GROUND_MOVES: Record<string, boolean> = {
    EARTHQUAKE: true, FISSURE: true, MAGNITUDE: true,
  };

  // .CheckPlayerHasUsableMoves skips the disabled slot (engine/battle/core.asm:5290-5305).
  // Lua: Battle.lua:1078
  hasUsableMoves(mon: BattleMon): boolean {
    const disabled = truthy(mon) && truthy(mon.volatile) ? mon.volatile.disabled : undefined;
    for (const move of (truthy(mon) ? mon.moves : undefined) ?? []) {
      if ((move.pp ?? 0) > 0 && move.id !== disabled) return true;
    }
    return false;
  }

  // Lua: Battle.lua:1086
  findMove(mon: BattleMon, moveId: string | undefined): any {
    for (const move of mon.moves ?? []) {
      if (move.id === moveId) return move;
    }
    return undefined;
  }

  // A "state" is the per-mon volatile bookkeeping a turn needs: the charge a
  // two-turn move is midway through, a Substitute's remaining HP, the counters
  // Rollout and Fury Cutter ramp on, and what the mon took this turn so Counter
  // and Mirror Coat have something to answer.  It hangs off the mon rather than
  // the battle so a switch takes it away, which is what the cart does.
  // Lua: Battle.lua:1098
  volatile(mon: BattleMon): Record<string, any> {
    mon.volatile = mon.volatile ?? {};
    return mon.volatile;
  }

  // Clears everything a switch clears (ResetBattleParticipants / SwitchOutMon).
  //
  // SwitchOutMon reloads the battle struct from the party slot, which is what
  // takes a Transform down with the switch; the port's one-table-per-mon shape
  // makes that a restore rather than a reload (Battle:untransform).  It has to
  // happen HERE and not only at the switch sites, because CleanUpBattleRAM at
  // the end of the battle runs through Battle:clearAllVolatiles -- and for a
  // wild catch that table is already sitting in the player's party.
  // Lua: Battle.lua:1111
  clearVolatile(mon: BattleMon): void {
    if (!truthy(mon)) return;
    this.untransform(mon);
    delete mon.volatile;
    // engine/battle/core.asm:3871
    if (mon === this.player || mon === this.enemy) {
      if (truthy(this.player) && truthy(this.player.volatile)) {
        this.player.volatile.attract = undefined;
      }
      if (truthy(this.enemy) && truthy(this.enemy.volatile)) {
        this.enemy.volatile.attract = undefined;
      }
    }
  }

  // The cart keeps every substatus in battle RAM (wPlayerSubStatus1-5), which
  // NewBattleMonStatus zeroes at each send-out and CleanUpBattleRAM zeroes on
  // the way out of the battle.  This port hangs the same bookkeeping off the mon
  // record, and Battle.party IS save.party, so nothing a battle wrote may be
  // left on a party table: an X item's bit, a confusion count or a wrap counter
  // would otherwise be written to the save file and read back by the next
  // battle, where DIRE HIT is then refused forever as an already-set bit.
  // Lua: Battle.lua:1133
  clearAllVolatiles(): void {
    for (const mon of this.party ?? []) this.clearVolatile(mon);
    for (const mon of this.enemyParty ?? []) this.clearVolatile(mon);
    this.clearVolatile(this.player);
    this.clearVolatile(this.enemy);
  }

  // One damaging hit.  Returns [the damage actually dealt (0 when the move did
  // not connect at all), info], so recoil, drain and Counter all read the same
  // number.
  // Lua: Battle.lua:1155
  hitOnce(attacker: BattleMon, defender: BattleMon, def: any, opts?: Record<string, any>): [number, any] {
    opts = opts ?? {};
    const attackerStages = this.stages[this.sideOf(attacker)];
    const defenderStages = this.stages[this.sideOf(defender)];
    const types = truthy(this.data.type_chart) ? this.data.type_chart.types : undefined;
    const matchups = this.matchupsAgainst(defender);

    const [heldEffect, heldParam] = this.heldEffect(attacker, "damage");
    // BattleCommand_Critical: SUBSTATUS_FOCUS_ENERGY (Focus Energy or a
    // DIRE HIT) and HELD_CRITICAL_UP (Scope Lens) each raise the ladder a
    // rung; a high-crit move raises it two.
    const criticalLevel = Damage.criticalLevel({
      highCritMove: def.effect === "EFFECT_ALWAYS_CRIT",
      focusEnergy: this.volatile(attacker).focusEnergy,
      scopeLens: heldEffect === "HELD_CRITICAL_UP",
    });
    // battle.crit, the same hook src/battle/Damage.lua calls on Gen 1, with the
    // same ctx keys.  `ruleset` has no Gen 2 counterpart (Gold's engine IS the
    // ruleset) so it is absent rather than invented, and `criticalLevel` is the
    // Gen 2 addition -- the rung of data/battle/critical_hit_chances.asm this
    // hit reached.
    let critical: boolean;
    if (Runtime.wantsHook("battle.crit")) {
      critical = Runtime.call("battle.crit", (c: any) => Damage.rollCritical(c.criticalLevel, c.battle.random),
        { battle: this, attacker, moveId: opts.moveId ?? def.id,
          rng: this.roller(), random: this.random,
          highCrit: def.effect === "EFFECT_ALWAYS_CRIT",
          criticalLevel });
    } else {
      critical = Damage.rollCritical(criticalLevel, this.random);
    }
    let attack = this.battleStat(attacker, "attack");
    // Burn halves physical Attack (Gen 2 does this in DamageStats), off the
    // status record's statPenalty.
    attack = Battle.statusPenaltyFor(this.data, attacker, "attack", attack);
    // The HELD_<TYPE>_BOOST items (Charcoal, Mystic Water, ...): the item's
    // parameter is the percent boost DamageCalc's .DoneItem applies when the
    // held type matches the move's.  PSYCHIC's type id is PSYCHIC_TYPE in the
    // port's chart, so the effect name is rebuilt from the move type.
    let itemBoost: number | undefined;
    if (truthy(def.type) && truthy(heldEffect)) {
      const wanted = "HELD_" + (def.type === "PSYCHIC_TYPE" ? "PSYCHIC" : def.type) + "_BOOST";
      if (heldEffect === wanted) itemBoost = heldParam;
    }
    const calcOpts: Record<string, any> = {
      level: attacker.level ?? 1,
      power: opts.power ?? def.power,
      moveType: def.type,
      attacker: {
        attack,
        specialAttack: this.battleStat(attacker, "specialAttack"),
        types: this.battleTypes(attacker),
        stages: attackerStages,
      },
      defender: {
        defense: this.battleStat(defender, "defense"),
        specialDefense: this.battleStat(defender, "specialDefense"),
        types: this.battleTypes(defender),
        stages: defenderStages,
      },
      types,
      matchups,
      critical,
      itemBoostPercent: itemBoost,
      // DoWeatherModifiers, the first thing BattleCommand_Stab farcalls
      // (effect_commands.asm:1254): rain boosts Water and cuts Fire, sun the
      // reverse, and rain cuts Solarbeam by its EFFECT rather than its type.
      // Scaled to the cart's tenths here so Damage.calc can apply it where the
      // cart does, ahead of the badge boost, STAB, the type rows and the roll.
      weatherPercent: Math.floor(
        Effects.weatherModifier(this.weather, def.type, def.effect) * 10),
      // DoBadgeTypeBoosts, farcalled between the weather modifiers and STAB.
      badgeTypeBoost: this.badgeTypeBoost(attacker, def.type),
      // SCREENS_REFLECT / SCREENS_LIGHT_SCREEN on the defending side double
      // the matching defence (the crit exemption lives in Damage.calc).
      screen: this.screenActive(defender, Damage.isPhysical(def.type, types)),
      // BattleCommand_DamageCalc's `srl c` (effect_commands.asm:2905-2913).
      defenseHalved: def.effect === "EFFECT_SELFDESTRUCT",
      // BattleCommand_Stab's `cp STRUGGLE / ret z`: no type, no STAB.
      typeless: (opts.moveId ?? def.id) === Battle.STRUGGLE,
      random: this.random,
    };
    // battle.damage, the same hook BattleState:computeDamage calls on Gen 1 and
    // with the same ctx keys: `user`, `target`, `move` and the `opts` table the
    // formula is actually run on.  The ctx table is only built when a chain is
    // installed, so a mod-free boot pays nothing.
    let damage: number;
    let info: any;
    if (Runtime.wantsHook("battle.damage")) {
      const out = Runtime.call("battle.damage", (c: any): [number, any] => Damage.calc(c.opts),
        { battle: this, user: attacker, target: defender, move: def,
          moveId: opts.moveId ?? def.id, opts: calcOpts,
          rng: this.roller(), random: this.random });
      damage = out[0];
      info = out[1];
      info = normalizeDamageInfo(info) ?? { effectiveness: 10 };
      damage = damage ?? 0;
    } else {
      [damage, info] = Damage.calc(calcOpts);
    }

    if (info.effectiveness === 0) {
      // BattleCommand_Stab's `.GotMatchup` arm writes wAttackMissed when the
      // matchup byte is 0 (effect_commands.asm:1337), and `stab` runs ahead of
      // `moveanim` in every damaging effect list (data/moves/effects.asm:5), so
      // BattleCommand_MoveAnimNoSub's wAttackMissed early-out (:1958) turns an
      // immune hit into MoveDelay and no animation at all.
      this.markMissed();
      this.emit({ kind: "message",
        text: Strings.get("It doesn't affect %s...", this.monName(defender)) });
      return [0, info];
    }
    // BattleCommand_FalseSwipe (engine/battle/move_effects/false_swipe.asm):
    // wCurDamage is capped at the target's HP minus one before applydamage, so
    // the move can never KO.
    if (def.effect === "EFFECT_FALSE_SWIPE" && damage >= (defender.hp ?? 0)) {
      damage = Math.max(0, (defender.hp ?? 0) - 1);
    }
    // engine/battle_anims/anim_commands.asm:1200
    if (truthy(this.moveEvent)) this.moveEvent.effectiveness = info.effectiveness;
    return [this.dealDamage(attacker, defender, damage, {
      critical, effectiveness: info.effectiveness,
      // Counter answers physical damage and Mirror Coat special, so what kind
      // of hit this was has to be recorded with it.
      kind: Damage.isPhysical(def.type, types) ? "physical" : "special",
      // Carried only so battle.damage_dealt can name the move.
      move: def, moveId: opts.moveId ?? def.id,
    }), info];
  }

  // Applies damage, routing it through the target's Substitute first: a
  // Substitute soaks the whole hit and breaks when it runs out
  // (BattleCommand_SubstituteFadeIfDead), so the mon behind it never loses HP.
  // Lua: Battle.lua:1296
  dealDamage(attacker: BattleMon, defender: BattleMon, damage: number | undefined, opts?: Record<string, any>): number {
    opts = opts ?? {};
    let dmg = Math.max(0, Math.floor(damage ?? 0));
    const state = this.volatile(defender);
    if ((state.substitute ?? 0) > 0) {
      const absorbed = Math.min(state.substitute, dmg);
      state.substitute = state.substitute - absorbed;
      this.emit({ kind: "message",
        text: Strings.get("The SUBSTITUTE took damage for %s!", this.monName(defender)) });
      if (state.substitute <= 0) {
        state.substitute = undefined;
        this.emit({ kind: "message",
          text: Strings.get("%s's SUBSTITUTE broke!", this.monName(defender)) });
      }
      return absorbed;
    }

    const defenderState = this.volatile(defender);
    // Endure leaves the holder on one hit point, however big the hit was.
    // BattleCommand_ApplyDamage calls BattleCommand_FalseSwipe unconditionally
    // for the Endure bit and FalseSwipe clamps wCurDamage to MonHP - 1, so a mon
    // braced at exactly 1 HP takes zero and still holds.
    // HELD_FOCUS_BAND rides the same clamp: the band is only consulted once
    // Endure is down, rolling one byte against the item parameter
    // (30 -> 30/256) and reusing the False Swipe clamp on success.
    let endured = false;
    let hungOn = false;
    if (truthy(defenderState.endure) && dmg >= (defender.hp ?? 0)
        && (defender.hp ?? 0) > 0) {
      dmg = (defender.hp ?? 0) - 1;
      endured = true;
    } else if (dmg >= (defender.hp ?? 0) && (defender.hp ?? 0) > 0) {
      const [effect, parameter] = this.heldEffect(defender, "endure");
      if (effect === "HELD_FOCUS_BAND"
          && rand(this.random, 256) < parameter) {
        dmg = (defender.hp ?? 0) - 1;
        hungOn = true;
      }
    }
    defender.hp = Math.max(0, (defender.hp ?? 0) - dmg);
    defenderState.tookThisTurn = (defenderState.tookThisTurn ?? 0) + dmg;
    defenderState.tookKind = opts.kind ?? "physical";
    // Bide stores everything the user takes while it is counting down.
    if (truthy(defenderState.bideTurns)) {
      defenderState.bideStored = (defenderState.bideStored ?? 0) + dmg;
    }
    this.emit({
      kind: "damage", side: this.sideOf(defender),
      amount: dmg, hp: defender.hp, critical: opts.critical,
      effectiveness: opts.effectiveness,
    });
    if (truthy(opts.critical)) {
      this.emit({ kind: "message", text: Strings.get("A critical hit!") });
    }
    // SuperEffectiveText / NotVeryEffectiveText (data/text/battle.asm:603,608).
    // The cart breaks both across the box's two lines and hyphenates "super-"
    // to do it, and the not-very line ends on the single ellipsis glyph Gold's
    // charmap carries at $75, not three periods.
    if (truthy(opts.effectiveness) && opts.effectiveness > 10) {
      this.emit({ kind: "message", text: Strings.get("It's super-\neffective!") });
    } else if (truthy(opts.effectiveness) && opts.effectiveness < 10) {
      this.emit({ kind: "message", text: Strings.get("It's not very\neffective…") });
    }
    if (endured) {
      this.emit({ kind: "message",
        text: Strings.get("%s endured the hit!", this.monName(defender)) });
    } else if (hungOn) {
      // HungOnText, named after the item the way the cart pipes it through
      // wStringBuffer1.
      const def = this.itemDef(defender.item);
      this.emit({ kind: "message",
        text: Strings.get("%s hung on with %s!", this.monName(defender),
          (truthy(def) && def.name) || "FOCUS BAND") });
    }
    // SUBSTATUS_RAGE: being hit while raging raises the rager's Attack.
    if (truthy(defenderState.rage) && dmg > 0 && (defender.hp ?? 0) > 0) {
      this.changeStage(defender, "attack", 1);
    }
    // SUBSTATUS_DESTINY_BOND: a move that knocks the bonded mon out takes its
    // user down too (BattleCommand_CheckFaint, TookDownWithItText).  Only a
    // move's own damage: residual chip and recoil own no `move`.
    if (dmg > 0 && (defender.hp ?? 0) <= 0 && truthy(defenderState.destinyBond)
        && truthy(opts.move) && truthy(attacker) && attacker !== defender
        && (attacker.hp ?? 0) > 0) {
      defenderState.destinyBond = undefined;
      const lost = attacker.hp;
      attacker.hp = 0;
      this.emit({ kind: "message", text: Strings.get("%s took down with it, %s!",
        this.monName(defender), this.monName(attacker)) });
      this.emit({ kind: "damage", side: this.sideOf(attacker), amount: lost,
        hp: 0, anim: false });
    }
    // battle.damage_dealt, the payload src/battle/EffectRegistry.lua emits once
    // per landed hit on Gen 1, guarded the same way so an unsubscribed boot
    // builds nothing.  `typeMult` is the x10 type multiplier under Gen 1's name;
    // Gen 2's own name for the same number is `effectiveness`, and both are here.
    // `move` is nil for the damage no move owns (Counter's answer, Future Sight's
    // delayed hit, spikes).
    if (Runtime.wants("battle.damage_dealt")) {
      Runtime.emit("battle.damage_dealt", {
        battle: this, user: attacker, target: defender,
        move: opts.move, moveId: opts.moveId,
        damage: dmg, crit: truthy(opts.critical) ? opts.critical : false,
        typeMult: opts.effectiveness ?? 10,
        // Gen 2 additions: which side took it and whether the hit was physical
        // or special, which is what Counter and Mirror Coat answer.
        effectiveness: opts.effectiveness ?? 10,
        side: this.sideOf(defender), kind: opts.kind,
      });
    }
    return dmg;
  }

  // Lua: Battle.lua:1396
  heal(mon: BattleMon, amount: number | undefined, opts?: Record<string, any>): number {
    const maxHp = mon.maxHp ?? (truthy(mon.stats) ? mon.stats.hp : undefined) ?? 1;
    const before = mon.hp ?? 0;
    mon.hp = Math.min(maxHp, before + Math.max(0, Math.floor(amount ?? 0)));
    const healed = mon.hp - before;
    if (healed > 0) {
      this.emit({ kind: "heal", side: this.sideOf(mon), amount: healed,
        hp: mon.hp, anim: truthy(opts) ? opts!.anim : opts });
    }
    return healed;
  }

  // move_effects/selfdestruct.asm:6-12: the user's status and both HP bytes are
  // zeroed, and the user's Leech Seed goes with them.
  // Lua: Battle.lua:1410
  selfdestructUser(attacker: BattleMon): void {
    const lost = attacker.hp ?? 0;
    attacker.status = undefined;
    attacker.statusTurns = undefined;
    attacker.toxicCounter = undefined;
    attacker.hp = 0;
    this.volatile(attacker).leechSeed = undefined;
    // The move carries ONE after-anim for the whole thing
    // (move_effects/selfdestruct.asm:2-3), and the target's hit already plays it.
    this.emit({ kind: "damage", side: this.sideOf(attacker),
      amount: lost, hp: 0, anim: false });
  }

  // One stat change, with the cart's own message (or its refusal).
  // Lua: Battle.lua:1423
  changeStage(target: BattleMon, stat: string, stages: number): boolean {
    const applied = Effects.applyStage(this.stages[this.sideOf(target)], stat, stages);
    const name = this.monName(target);
    if (!truthy(applied)) {
      // WontRiseAnymoreText / WontDropAnymoreText (data/text/battle.asm:718-732).
      const label = Strings.get((Effects.STAT_NAMES as Record<string, string>)[stat] ?? stat);
      const source = stages > 0
        ? Strings.source("%s's %s won't rise anymore!")
        : Strings.source("%s's %s won't drop anymore!");
      this.emit({ kind: "message", text: Strings.get(source, name, label) });
      return false;
    }
    this.emit({ kind: "stage", side: this.sideOf(target), stat,
      stages: applied, text: Effects.stageMessage(name, stat, applied as number) });
    return true;
  }

  // wAttackMissed, modelled on the event the screen animates off.  Every path
  // that sets it (CheckHit's .Miss arms and the effect commands' own `.failed`
  // tails, which reach AnimateFailedMove: a delay and no animation) marks the
  // move event, and the screen skips the attack animation for a marked one --
  // BattleCommand_MoveAnimNoSub, engine/battle/effect_commands.asm:1958.
  // Lua: Battle.lua:1446
  markMissed(): void {
    if (truthy(this.moveEvent)) this.moveEvent.missed = true;
  }

  // engine/battle/effect_commands.asm:3615
  // Lua: Battle.lua:1451
  static AI_FAIL_STATUSES: Record<string, boolean> = {
    sleep: true, poison: true, toxic: true, paralyze: true,
  };

  // engine/battle/effect_commands.asm:3615
  // Lua: Battle.lua:1456
  aiRandomFail(attacker: BattleMon, defender: BattleMon): boolean {
    if (truthy(this.linkBattle)) return false;
    if (this.sideOf(attacker) !== "enemy") return false;
    if (truthy(this.volatile(defender).lockOn)) return false;
    return rand(this.random, 256) < 64;
  }

  // One attack, start to finish.
  // Lua: Battle.lua:1464
  useMove(attacker: BattleMon, defender: BattleMon, moveId: string): void {
    const move = this.findMove(attacker, moveId);
    const def = this.moveDef(moveId);
    const name = this.monName(attacker);
    const state = this.volatile(attacker);
    // wAttackMissed is per-move: BattleTurn's ResetTurn clears it before the
    // effect list runs, so nothing a previous move set can reach this one.
    this.moveEvent = undefined;
    if (!truthy(def)) {
      this.emit({ kind: "message", text: Strings.get("%s has no move to use!", name) });
      return;
    }

    // A mon locked into the second half of a two-turn move spends no PP and
    // makes no new choice: it just lands the stored attack.
    const charging = state.chargeMove === moveId;
    // engine/battle/effect_commands.asm:5421
    const wasVanished = (charging && truthy(state.vanished)) ? true : undefined;
    if (charging) {
      state.chargeMove = undefined;
      state.vanished = undefined;
    }

    // BattleCommand_CheckRampage (effect_commands.asm:4851) is the FIRST command
    // in the Rampage list, ahead of checkobedience and doturn, and
    // SkipToBattleCommand leaves the script pointer PAST the command it looked
    // for (:6674-6689) -- so a continuing Thrash or Petal Dance spends no PP,
    // makes no obedience check and never re-rolls its count.  The counter runs
    // down here; when it reaches zero the lock ends and the user is confused,
    // and the move STILL resolves this turn (`.continue_rampage`).
    const rampaging = def.effect === "EFFECT_RAMPAGE"
      && state.rampageMove === moveId && (state.rampageTurns ?? 0) > 0;
    if (rampaging) {
      state.rampageTurns = state.rampageTurns - 1;
      if (state.rampageTurns <= 0) {
        state.rampageMove = undefined;
        state.rampageTurns = undefined;
        // CheckRampage writes SUBSTATUS_CONFUSED and the count itself rather
        // than calling FinishConfusingTarget, so there is no text, no
        // Substitute test and no HELD_PREVENT_CONFUSE test -- just the same
        // `and %00000001` plus two roll, 2 or 3 turns.  The cart's one
        // exemption is the user's own Safeguard, which this port does not model
        // yet.
        state.confuseCount = truthy(state.confuseCount)
          ? state.confuseCount : rand(this.random, 2) + 2;
      }
    }

    // BattleCommand_CheckRollout (move_effects/rollout.asm) skips past
    // doturn_command while SUBSTATUS_ROLLOUT is set, so a continuing Rollout is
    // free of PP and obedience in exactly the same way.
    const rolling = state.rolloutLock === moveId;

    // engine/battle/effect_commands.asm:977-979, data/moves/effects.asm:795-800,
    // engine/battle/move_effects/bide.asm:62-68
    const biding = def.effect === "EFFECT_BIDE" && state.bideTurns != null;

    // engine/battle/effect_commands.asm:6222-6234, :949-951
    const called = (this.copyDepth ?? 0) > 0;

    if (!(charging || rampaging || rolling || biding || called)) {
      if (truthy(move) && (move.pp ?? 0) <= 0) {
        // BattleText_TheresNoPPLeftForThisMove (data/text/battle.asm:315).
        this.emit({ kind: "message",
          text: Strings.get("There's no PP left\nfor this move!") });
        return;
      }
      if (truthy(move)) move.pp = (move.pp ?? 1) - 1;
      // BattleCommand_Rampage (effect_commands.asm:4886): the opening turn rolls
      // 1 or 2 MORE turns of lock-in, so Thrash and Petal Dance run for two or
      // three turns in all.  A mon acting through Sleep Talk never rampages.
      if (def.effect === "EFFECT_RAMPAGE" && attacker.status !== "sleep") {
        state.rampageMove = moveId;
        state.rampageTurns = rand(this.random, 2) + 1;
      }
    }

    // BattleCommand_Rage sets SUBSTATUS_RAGE and leaves the move to hit
    // normally; any OTHER move clears it, which is why Rage has no entry in
    // MOVE_EFFECTS -- it falls straight through to the damage path.
    state.rage = (def.effect === "EFFECT_RAGE") || undefined;
    // UsedMoveText is built out of _ActorNameText followed by _UsedMove1Text,
    // which is `text_start` plus `line "used @"` (data/text/common_2.asm:339),
    // so the break after the user's name is part of the string and lands on the
    // box's second row however short the name is.
    //
    // The event is kept so the miss paths below can mark it: the screen animates
    // off this event, and BattleCommand_MoveAnimNoSub
    // (engine/battle/effect_commands.asm:1958) opens on
    // `ld a, [wAttackMissed] / and a / jp nz, BattleCommand_MoveDelay`, so a
    // move that missed or failed burns the delay and plays nothing at all.
    this.moveEvent = this.emit({ kind: "move", side: this.sideOf(attacker),
      move: moveId, wasVanished,
      afterAnim: (Effects.AFTER_ANIM as Record<string, any>)[def.effect],
      text: Strings.get("%s\nused %s!", name, def.name ?? moveId) });

    // battle.move_used, where BattleState:executeMove raises it on Gen 1: after
    // the announcement and before the effect runs, so a mod sees the move that
    // is about to resolve.  `isCalled` is true for the move Metronome or Mirror
    // Move picked -- Gen 2 tracks that as the copy depth rather than a flag.
    if (Runtime.wants("battle.move_used")) {
      Runtime.emit("battle.move_used", {
        battle: this, user: attacker, target: defender, move: def,
        isCalled: (this.copyDepth ?? 0) > 0,
        // Gen 2 additions: the id on its own (Gen 1 mods read move.id), and
        // which side is swinging.
        moveId, side: this.sideOf(attacker),
      });
    }

    // Metronome and Mirror Move do not attack: they pick another move and run
    // it instead (both end in `ResetTurn`).  `copyDepth` is the port's own
    // guard -- the cart cannot recurse because it restarts the turn, and
    // Metronome's own exception list keeps it from picking itself.
    if (def.effect === "EFFECT_METRONOME" || def.effect === "EFFECT_MIRROR_MOVE") {
      let picked: string | undefined;
      if (def.effect === "EFFECT_METRONOME") {
        let order = (this.data.constants ?? {}).moveOrder;
        if (!truthy(order)) {
          order = truthy(this.data.moves) ? this.data.moves.order : undefined;
        }
        picked = Effects.metronomePick(truthy(order) ? order : this.moveOrder(),
          attacker.moves, this.random);
      } else {
        // Mirror Move copies the OPPONENT's last move and fails when there is
        // none, or when the user already knows it (CheckUserMove).
        const last = this.volatile(defender).lastMove;
        picked = last;
        for (const own of attacker.moves ?? []) {
          if (own.id === last) { picked = undefined; break; }
        }
      }
      if (!truthy(picked) || (this.copyDepth ?? 0) > 0) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
        return;
      }
      this.copyDepth = (this.copyDepth ?? 0) + 1;
      this.useMove(attacker, defender, picked!);
      this.copyDepth = this.copyDepth - 1;
      return;
    }

    // engine/battle/move_effects/sleep_talk.asm:2, :16-19, :61
    if (def.effect === "EFFECT_SLEEP_TALK") {
      let picked: string | undefined;
      if (attacker.status === "sleep" && (this.copyDepth ?? 0) === 0) {
        // engine/battle/move_effects/sleep_talk.asm:40-44, :117-141
        const pool: string[] = [];
        for (const own of attacker.moves ?? []) {
          const ownDef = this.moveDef(own.id);
          const effect = truthy(ownDef) ? ownDef.effect : undefined;
          if (own.id !== moveId && !truthy(this.moveDisabled(attacker, own.id))
              && !truthy((Effects.CHARGE as Record<string, any>)[effect]) && effect !== "EFFECT_BIDE") {
            pool.push(own.id);
          }
        }
        if (pool.length > 0) picked = pool[rand(this.random, pool.length)];
      }
      if (!truthy(picked)) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
        return;
      }
      state.lastMove = undefined;
      this.copyDepth = (this.copyDepth ?? 0) + 1;
      this.useMove(attacker, defender, picked!);
      this.copyDepth = this.copyDepth - 1;
      return;
    }

    // Everything past here counts as "the user's last move" for Mirror Move,
    // Encore and Disable.  A called move skips the write
    // (engine/battle/used_move_text.asm:30-36).
    if ((this.copyDepth ?? 0) === 0) state.lastMove = moveId;
    state.turnsTaken = (state.turnsTaken ?? 0) + 1;
    state.usedMoves = state.usedMoves ?? [];
    let seen = false;
    for (const id of state.usedMoves) if (id === moveId) seen = true;
    if (!seen) state.usedMoves.push(moveId);

    // ParsePlayerAction (core.asm:618-624) and its enemy twin (core.asm:5621-
    // 5627) zero the protect count for any move that is not Protect or Endure.
    if (def.effect !== "EFFECT_PROTECT" && def.effect !== "EFFECT_ENDURE") {
      state.protectCount = undefined;
    }

    // Turn one of a charge move: print the line, remember the move, done.
    // BattleCommand_SkipSunCharge (effect_commands.asm:6488): in sun,
    // Solarbeam's effect list jumps straight past the charge command and the
    // beam fires in one turn.
    let charge: { text: string; vanish?: boolean } | undefined =
      (Effects.CHARGE as Record<string, { text: string; vanish?: boolean }>)[def.effect];
    if (def.effect === "EFFECT_SOLARBEAM" && this.weather === "sun") {
      charge = undefined;
    }
    if (truthy(charge) && !charging && Runtime.wantsHook("battle.charge_required")) {
      const required = Runtime.call("battle.charge_required", (c: any) => c.charge, {
        battle: this, user: attacker, target: defender, move: def,
        charge: true, isCalled: (this.copyDepth ?? 0) > 0,
      });
      if (required === false) charge = undefined;
    }
    if (truthy(charge) && !charging) {
      state.chargeMove = moveId;
      state.vanished = orNil(charge!.vanish);
      // engine/battle/effect_commands.asm:5456-5458
      if (truthy(this.moveEvent)) {
        this.moveEvent.animParam = 1;
        this.moveEvent.afterAnim = undefined;
      }
      // BattleCommand_Charge picks the line off the MOVE, not the shared
      // EFFECT_FLY (`cp DIG`, effect_commands.asm:5464).
      let text = charge!.text;
      if (moveId === "DIG") text = Strings.source("%s dug a hole!");
      this.emit({ kind: "message", text: Strings.get(text, name) });
      return;
    }

    // BattleCommand_Snore (engine/battle/move_effects/snore.asm:1-9)
    if (def.effect === "EFFECT_SNORE" && attacker.status !== "sleep") {
      this.markMissed();
      this.emit({ kind: "message", text: Strings.get("But it failed!") });
      return;
    }

    // Counter and Mirror Coat answer what the user took this turn, at double,
    // and fail outright when nothing of the right kind landed.
    const counterKind = (Effects.COUNTER as Record<string, any>)[def.effect];
    if (truthy(counterKind)) {
      const taken = state.tookThisTurn ?? 0;
      if (taken <= 0 || state.tookKind !== counterKind) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
        return;
      }
      this.dealDamage(attacker, defender, Effects.counterDamage(taken),
        { move: def, moveId });
      return;
    }

    // Protect turns the whole move aside before accuracy is even rolled.
    if (truthy(this.volatile(defender).protect)
        && !truthy((Effects.NO_CHECKHIT as Record<string, any>)[def.effect])) {
      // CheckHit's .Protect arm jumps to .Miss (effect_commands.asm:1557).
      if (def.effect === "EFFECT_SELFDESTRUCT") this.selfdestructUser(attacker);
      this.markMissed();
      this.emit({ kind: "message",
        text: Strings.get("%s protected itself!", this.monName(defender)) });
      return;
    }

    // BattleCommand_CheckHit's .LockOn: the flag Lock-On left on the TARGET is
    // read and cleared by the very next move aimed at it, and while it is up the
    // accuracy roll does not happen at all.
    const locked = this.consumeLockOn(defender);
    // CheckHit's .XAccuracy and EFFECT_ALWAYS_HIT arms
    // (effect_commands.asm:1572-1579).
    const sureHit = truthy(locked) ? locked
      : (this.volatile(attacker).xAccuracy === true || def.effect === "EFFECT_ALWAYS_HIT");

    // .LockOn runs ahead of .FlyDigMoves and returns a HIT unless the target is
    // flying and the move is one of the three (effect_commands.asm:1563-1567,
    // :1674-1691).
    const lockedThrough = truthy(locked) && !(
      this.volatile(defender).chargeMove === "FLY"
      && truthy(Battle.LOCK_ON_GROUND_MOVES[moveId]));

    // .FlyDigMoves: four moves reach a flying target, three an underground one
    // (effect_commands.asm:1566-1567, :1713-1746).
    if (truthy(this.volatile(defender).vanished) && !lockedThrough
        && !truthy((Effects.NO_CHECKHIT as Record<string, any>)[def.effect])
        && !Effects.hitsVanished(this.volatile(defender).chargeMove, moveId)) {
      // CheckHit's .Miss only sets wAttackMissed (effect_commands.asm:1619-1630),
      // so `selfdestruct` still runs ahead of failuretext.
      if (def.effect === "EFFECT_SELFDESTRUCT") this.selfdestructUser(attacker);
      this.markMissed();
      this.emit({ kind: "message", text: Strings.get("%s's attack missed!", name) });
      return;
    }

    // The status-shaped moves: each one either sets its own state and returns,
    // or falls through to the ordinary damage path.  Through the merged
    // `move_effects` record, so a mod's own primary effect is dispatched here
    // the way BattleState:performMove dispatches one on Gen 1.
    const effectRecord = Battle.moveEffectRecordFor(this.data, def.effect);
    const handler = truthy(effectRecord) ? effectRecord.run : undefined;
    if (truthy(handler)) {
      handler(this, attacker, defender, def, moveId, sureHit);
      return;
    }

    // BattleCommand_CheckHit opens on `call .DreamEater / jp z, .Miss`
    // (engine/battle/effect_commands.asm:1554): DREAM EATER against a target
    // that is not asleep is a MISS, before anything is rolled, so no damage
    // lands and nothing is sapped.  The gate sits ahead of CheckHit's .LockOn
    // and .XAccuracy arms, which is why `sureHit` does not carry the move past
    // it.
    if (def.effect === "EFFECT_DREAM_EATER" && defender.status !== "sleep") {
      this.markMissed();
      this.emit({ kind: "message", text: Strings.get("%s's attack missed!", name) });
      return;
    }

    // MAGNITUDE rolls its power before checkhit (`getmagnitude` sits between
    // damagestats and damagecalc, data/moves/effects.asm:1705), so the number is
    // announced even on a miss.  The rolled power replaces the move's stored
    // one, which the ROM keeps at 1 for exactly this reason.
    let powerOverride: number | undefined;
    if (def.effect === "EFFECT_MAGNITUDE") {
      const [rolled, number] = Effects.magnitudePower(this.random);
      powerOverride = rolled;
      // engine/battle/move_effects/magnitude.asm:20-22
      if (truthy(this.moveEvent)) {
        this.moveEvent.deferAnim = true;
        this.moveEvent.animDelay = true;
      }
      this.emit({ kind: "message", text: Strings.get("Magnitude %d!", number) });
      // data/moves/effects.asm:1705-1711
      this.moveEvent = this.emit({ kind: "message",
        moveAnim: moveId, side: this.sideOf(attacker) });
    }

    // data/moves/effects.asm:1607, :1649
    if (def.effect === "EFFECT_RETURN") {
      powerOverride = Effects.happinessPower(attacker.happiness);
    } else if (def.effect === "EFFECT_FRUSTRATION") {
      powerOverride = Effects.happinessPower(attacker.happiness, true);
    }

    if (!truthy(sureHit)
        && !truthy(this.accuracyRoll(def, attacker, defender))) {
      // data/moves/effects.asm:148-151: `selfdestruct` sits between checkhit and
      // failuretext, so a missed Explosion still kills the user.
      if (def.effect === "EFFECT_SELFDESTRUCT") this.selfdestructUser(attacker);
      this.markMissed();
      this.emit({ kind: "message", text: Strings.get("%s's attack missed!", name) });
      // Fury Cutter's ramp resets the moment it misses.
      state.rampMove = undefined;
      state.rampCount = undefined;
      // BattleCommand_RolloutPower reads wAttackMissed before it touches the
      // counter and clears SUBSTATUS_ROLLOUT outright (rollout.asm), so a missed
      // Rollout releases the lock as well as the power ramp.  A missed rampage
      // does NOT: `rampage` runs ahead of checkhit and nothing reads the miss.
      state.rolloutLock = undefined;
      return;
    }

    // move_effects/selfdestruct.asm:6-12, run before applydamage.
    if (def.effect === "EFFECT_SELFDESTRUCT") this.selfdestructUser(attacker);

    // BattleCommand_Present (move_effects/present.asm): an immune target ends
    // it; otherwise one BattleRandom byte against PresentPower picks 40, 80 or
    // 120 power (40%, 30%, 10%), and past the table the target is HEALED a
    // quarter of its max HP instead -- or, already full, can't receive it.
    if (def.effect === "EFFECT_PRESENT") {
      const defenderTypes = this.battleTypes(defender);
      if (Damage.typeMultiplier(def.type, defenderTypes, this.matchupsAgainst(defender)) === 0) {
        this.markMissed();
        this.emit({ kind: "message",
          text: Strings.get("It doesn't affect %s...", this.monName(defender)) });
        return;
      }
      const roll = rand(this.random, 256);
      const power = Effects.presentPower(roll);
      if (power === 0) {
        const maxHp = defender.maxHp ?? defender.stats?.hp ?? 1;
        if ((defender.hp ?? 0) >= maxHp) {
          this.emit({ kind: "message",
            text: Strings.get("%s can't receive the gift!", this.monName(defender)) });
          return;
        }
        this.heal(defender, Math.max(1, Math.floor(maxHp / 4)));
        this.emit({ kind: "message",
          text: Strings.get("%s regained health!", this.monName(defender)) });
        return;
      }
      powerOverride = power;
    }

    // Substitute: a quarter of max HP, refused when the user has no more than
    // that to give.
    if (def.effect === "EFFECT_SUBSTITUTE") {
      const maxHp = attacker.maxHp ?? (truthy(attacker.stats) ? attacker.stats.hp : undefined) ?? 1;
      const cost = Effects.substituteCost(maxHp);
      if ((attacker.hp ?? 0) <= cost || (state.substitute ?? 0) > 0) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
        return;
      }
      attacker.hp = attacker.hp - cost;
      state.substitute = cost;
      // The cost is paid silently: SUBSTITUTE's own anim is all that plays
      // (move_effects/substitute.asm:57-68).
      this.emit({ kind: "damage", side: this.sideOf(attacker), amount: cost,
        hp: attacker.hp, anim: false });
      this.emit({ kind: "message", text: Strings.get("%s made a SUBSTITUTE!", name) });
      return;
    }

    // Damage that skips the formula entirely.  The move's own power goes with
    // it: EFFECT_STATIC_DAMAGE's arm of BattleCommand_ConstantDamage reads
    // BATTLE_VARS_MOVE_POWER as the damage (effect_commands.asm:3157-3161).
    const fixed = Effects.fixedDamage(def.effect, attacker, defender, this.random, def.power);
    if (truthy(fixed)) {
      // The constant-damage effect list carries `resettypematchup` instead of
      // `stab`, and that command misses the move outright when the matchup byte
      // is 0 (effect_commands.asm:1480-1493) -- an immune target is the one
      // thing that stops SONIC BOOM, NIGHT SHADE or SUPER FANG.
      const defenderTypes = this.battleTypes(defender);
      const matchups = this.matchupsAgainst(defender);
      if (Damage.typeMultiplier(def.type, defenderTypes, matchups) === 0) {
        this.markMissed();
        this.emit({ kind: "message",
          text: Strings.get("It doesn't affect %s...", this.monName(defender)) });
        return;
      }
      this.dealDamage(attacker, defender, fixed, { move: def, moveId });
      return;
    }

    let dealt = 0;
    let info: any = undefined;
    if ((powerOverride ?? def.power ?? 0) > 0) {
      // Rollout and Fury Cutter double their power for each consecutive use.
      let power: number = powerOverride ?? def.power;
      const ramping = (Effects.RAMPING as Record<string, number>)[def.effect];
      if (truthy(ramping)) {
        // The two ramps are separate bytes on the cart with separate reset
        // rules, so "is this a continuation?" is asked differently for each.
        //
        // ROLLOUT: BattleCommand_CheckRollout's `.reset` arm zeroes
        // wPlayerRolloutCount whenever SUBSTATUS_ROLLOUT is CLEAR as the move
        // starts (move_effects/rollout.asm), and the fifth hit is what clears
        // that bit.  So a sequence that has run its five hits out does NOT feed
        // the next one: picking ROLLOUT again opens a fresh count, at base power
        // and re-locked.
        //
        // FURY CUTTER: wPlayerFuryCutterCount has no such bit.  It is zeroed by
        // ResetFuryCutterCount, which move_effects/fury_cutter.asm calls on a
        // miss and effect_commands.asm:355 calls whenever another move is used,
        // which is exactly the same-move test below.
        let continuing: boolean;
        if (def.effect === "EFFECT_ROLLOUT") {
          continuing = state.rolloutLock === moveId;
        } else {
          continuing = state.rampMove === moveId;
        }
        if (continuing) {
          state.rampCount = Math.min((state.rampCount ?? 0) + 1, ramping! - 1);
        } else {
          state.rampMove = moveId;
          state.rampCount = 0;
        }
        power = Effects.rampedPower(def.power, state.rampCount,
          def.effect === "EFFECT_ROLLOUT" && state.curled);
        // BattleCommand_RolloutPower's `.hit` arm sets SUBSTATUS_ROLLOUT while
        // the incremented counter is still short of MAX_ROLLOUT_COUNT and
        // clears it on the fifth (rollout.asm), and CheckPlayerLockedIn
        // (core.asm:546) offers no menu at all while the bit is set.  Fury
        // Cutter shares the power ramp but not the lock: its effect list
        // carries no checkrollout.  `rampCount` is the cart's counter minus
        // one, so the last locked turn is the one below the cap.
        if (def.effect === "EFFECT_ROLLOUT") {
          const last = state.rampCount >= (ramping! - 1);
          state.rolloutLock = !last ? moveId : undefined;
        }
      } else {
        state.rampMove = undefined;
        state.rampCount = undefined;
        state.rolloutLock = undefined;
      }

      const hits = Effects.hitCount(def.effect, this.roller());
      let landed = 0;
      for (let hit = 1; hit <= hits; hit++) {
        if ((defender.hp ?? 0) <= 0) break;
        let hitPower = power;
        if (def.effect === "EFFECT_TRIPLE_KICK") {
          hitPower = Effects.tripleKickPower(def.power, hit);
          // Each kick rolls its own accuracy and the sequence stops on a miss.
          if (hit > 1 && !truthy(sureHit)
              && !truthy(this.accuracyRoll(def, attacker, defender))) {
            break;
          }
        }
        let amount: number;
        [amount, info] = this.hitOnce(attacker, defender, def, { power: hitPower });
        if (truthy(info) && info.effectiveness === 0) {
          // rolloutpower sits after checkhit and reads the wAttackMissed that
          // `stab` set for the immunity, so an immune target breaks the Rollout
          // lock (rollout.asm, the arm above `.hit`).
          state.rolloutLock = undefined;
          return;
        }
        dealt = dealt + amount;
        landed = landed + 1;
      }
      if (landed > 1) {
        // PlayerHitTimesText / EnemyHitTimesText (data/text/battle.asm:749,755)
        // are "Hit @ times!".  Gen 2 has no singular form of this line.
        this.emit({ kind: "message", text: Strings.get("Hit %d times!", landed) });
      }

      // move_effects/pay_day.asm:13
      if (def.effect === "EFFECT_PAY_DAY" && dealt > 0) {
        this.payDay = (this.payDay ?? 0) + 2 * (attacker.level ?? 1);
        this.emit({ kind: "message", text: Strings.get("Coins scattered\neverywhere!") });
      }

      // Recoil is a quarter of what was dealt; drain heals half of it.
      if (def.effect === "EFFECT_RECOIL_HIT" && dealt > 0) {
        const recoil = Effects.recoilDamage(dealt);
        attacker.hp = Math.max(0, (attacker.hp ?? 0) - recoil);
        // BattleCommand_Recoil is bar, huds and RecoilText only: no anim at all
        // (effect_commands.asm:5674-5687).
        this.emit({ kind: "damage", side: this.sideOf(attacker),
          amount: recoil, hp: attacker.hp, anim: false });
        this.emit({ kind: "message", text: Strings.get("%s is hit with recoil!", name) });
      } else if (truthy((Effects.DRAIN as Record<string, any>)[def.effect]) && dealt > 0) {
        this.heal(attacker, Effects.drainAmount(dealt));
        this.emit({ kind: "message",
          text: Strings.get("%s's energy was drained!", this.monName(defender)) });
      }

      // BattleCommand_RechargeNextTurn (effect_commands.asm:5899): HYPER BEAM
      // sets SUBSTATUS_RECHARGE on the user, and CheckPlayerTurn /
      // CheckEnemyTurn spend the next turn clearing it.  Unlike Gen 1 there is
      // no "no recharge if it KOs" exemption; the command runs at the end of
      // the effect list whenever the move connected.
      if (def.effect === "EFFECT_HYPER_BEAM" && dealt > 0) {
        state.recharge = true;
      }

      // BattleCommand_HeldFlinch (effect_commands.asm:5349): a damaging move
      // that connected lets the ATTACKER's HELD_FLINCH item (King's Rock)
      // flinch the target, one byte against the parameter (30 -> 30/256).
      // Silent when it lands -- the message is the target's own "flinched!"
      // when it tries to act.  A Substitute blocks it.
      if (dealt > 0 && (defender.hp ?? 0) > 0) {
        const [held, parameter] = this.heldEffect(attacker, "flinch");
        if (held === "HELD_FLINCH"
            && (this.volatile(defender).substitute ?? 0) <= 0
            && rand(this.random, 256) < parameter) {
          this.volatile(defender).flinched = true;
        }
      }

      // BattleCommand_FlinchTarget (effect_commands.asm:5314): the *_HIT
      // flinch moves (Rock Slide, Headbutt, Bite) roll the move's effect
      // chance after a connected hit; a Substitute blocks it.  Silent when it
      // lands, same as the held-item flinch above.
      if (def.effect === "EFFECT_FLINCH_HIT" && dealt > 0
          && (defender.hp ?? 0) > 0
          && (this.volatile(defender).substitute ?? 0) <= 0) {
        const chance = def.effectChance ?? 0;
        if (chance > 0 && rand(this.random, 100) < chance) {
          this.volatile(defender).flinched = true;
        }
      }

      // BattleCommand_TrapTarget (effect_commands.asm:5569): a connected Bind
      // class hit starts a 2-5 turn partial trap on the target -- unless one
      // is already running or a Substitute is up.  The stored count is
      // `and %11` plus three because HandleWrap decrements BEFORE it acts, so
      // a count of n hurts on n-1 turns and releases on the last.
      if (def.effect === "EFFECT_TRAP_TARGET" && dealt > 0
          && (defender.hp ?? 0) > 0) {
        const target = this.volatile(defender);
        if (!truthy(target.wrapCount) && (target.substitute ?? 0) <= 0) {
          target.wrapCount = rand(this.random, 4) + 3;
          target.wrapMove = def.name ?? moveId;
          // wFXAnimID keeps the trapping move itself, which is what HandleWrap
          // replays every turn (core.asm:1185-1202).
          target.wrapMoveId = moveId;
          const trapText = Battle.TRAP_TEXT[moveId];
          let text = truthy(trapText) ? trapText(this.monName(defender), name) : undefined;
          if (!truthy(text)) text = Strings.get("%s was trapped!", this.monName(defender));
          this.emit({ kind: "message", text });
        }
      }
    }

    // Defense Curl arms Rollout as well as raising Defense.
    if (def.effect === "EFFECT_DEFENSE_CURL") state.curled = true;

    // A refused primary change writes wAttackMissed (effect_commands.asm:4191,
    // :4380-4400); the *_HIT twins animate first and must stay unmarked.
    const change = (Effects.STAT_CHANGES as Record<string, any>)[def.effect];
    if (truthy(change)) {
      const target = change[2] === "self" ? attacker : defender;
      // CheckMist first (effect_commands.asm:4290), then .ComputerMiss (:4318)
      const misted = target !== attacker && (change[1] ?? 0) < 0
        && this.volatile(target).mist;
      if (!truthy(misted) && change[2] === "foe"
          && def.effect !== "EFFECT_ACCURACY_DOWN_HIT"
          && this.aiRandomFail(attacker, target)) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
      } else if (!truthy(this.changeStageAgainstMist(attacker, target, change[0], change[1]))) {
        this.markMissed();
      }
    } else {
      const onHit = (Effects.STAT_CHANGES_ON_HIT as Record<string, any>)[def.effect];
      if (truthy(onHit) && dealt > 0) {
        const chance = def.effectChance ?? 0;
        if (chance > 0 && rand(this.random, 100) < chance) {
          const target = onHit[2] === "self" ? attacker : defender;
          this.changeStageAgainstMist(attacker, target, onHit[0], onHit[1]);
        }
      } else if (def.effect === "EFFECT_ALL_UP_HIT" && dealt > 0) {
        const chance = def.effectChance ?? 0;
        if (chance > 0 && rand(this.random, 100) < chance) {
          for (const stat of Effects.ALL_UP_STATS) {
            this.changeStage(attacker, stat, 1);
          }
        }
      }
    }

    // Status moves land their status; damaging moves roll their effect chance.
    // Both come off the merged `move_effects` record: a primary record's
    // `status` is the one a zero-power move lands, a secondary record's is the
    // one rolled against the move's effect chance after a hit.
    const record = Battle.moveEffectRecordFor(this.data, def.effect);
    const status = truthy(record) && record.kind === "primary" ? orNil(record.status) : undefined;
    if (truthy(status) && (def.power ?? 0) === 0) {
      // A refused primary status is a failed move (effect_commands.asm:3748,
      // :6656); a refused secondary already animated and stays unmarked (:3752).
      if (truthy(this.statusRefusedByType(defender, def.type, status))) {
        this.markMissed();
        this.emit({ kind: "message",
          text: Strings.get("It doesn't affect %s...", this.monName(defender)) });
      } else if (truthy(Battle.AI_FAIL_STATUSES[status])
          && this.aiRandomFail(attacker, defender)) {
        this.markMissed();
        this.emit({ kind: "message", text: Strings.get("But it failed!") });
      } else if (!truthy(this.applyStatus(defender, status, attacker))) {
        this.markMissed();
      }
    } else {
      const secondary = truthy(record) && record.kind === "secondary"
        ? orNil(record.status) : undefined;
      // engine/battle/effect_commands.asm:6325
      if (truthy(secondary) && (defender.hp ?? 0) > 0
          && !truthy(this.safeguarded(defender))
          && !truthy(this.statusRefusedByType(defender, def.type, secondary))) {
        const chance = def.effectChance ?? 0;
        if (chance > 0 && rand(this.random, 100) < chance) {
          this.applyStatus(defender, secondary, attacker);
        }
      }
    }
  }

  // ------------------------------------------------------------------------
  // The moves whose whole job is to set state (Battle.lua:2106-2120)
  // ------------------------------------------------------------------------
  //
  // Each entry is one command out of engine/battle/move_effects/, and each one
  // either sets its state and returns or prints the cart's own failure line.
  // Anything NOT in this table falls through to the ordinary damage path, which
  // is what keeps an unmodelled effect honest.
  //
  // Cross-file contract: useMove does NOT dispatch on this table any more, it
  // dispatches on Battle.MOVE_EFFECT_RECORDS, which is folded out of this one
  // (and out of STATUS_EFFECTS / SECONDARY_EFFECTS) at the bottom of the block.
  // A new effect goes here, ABOVE that fold; one added below it would be a
  // handler nothing ever calls.  The handlers themselves are assigned after
  // the class (module level), in the Lua's order.
  // Lua: Battle.lua:2121
  static MOVE_EFFECTS: Record<string, MoveEffectRun> = {};

  // BattleCommand_CheckHit's .LockOn: the flag is read AND cleared by the next
  // move aimed at the mon carrying it, whether or not that move was the one the
  // lock-on was meant for, and whether or not the exception at :1683-1688 then
  // misses (effect_commands.asm:1671-1672).
  // Lua: Battle.lua:2249
  consumeLockOn(defender: any): boolean {
    const target = this.volatile(defender);
    if (!truthy(target.lockOn)) return false;
    delete target.lockOn;
    return true;
  }

  // BattleCommand_CheckHit's `.BrightPowder`: the DEFENDER's HELD_BRIGHTPOWDER
  // subtracts its parameter (20) from the accuracy byte before the roll.  The
  // port rolls accuracy in the percent domain, so the byte penalty is scaled
  // by 100/256 and floored -- never below 1, because rollHit reads a
  // non-positive accuracy as "never misses", the exact opposite of the cart's
  // underflow-to-zero always-miss.
  // Lua: Battle.lua:2262
  moveAccuracy(accuracy: number | undefined, defender: any): number | undefined {
    if (!truthy(accuracy) || (accuracy as number) <= 0) return accuracy;
    const [effect, parameter] = this.heldEffect(defender, "accuracy");
    if (effect === "HELD_BRIGHTPOWDER") {
      accuracy = Math.max(1,
        (accuracy as number) - Math.floor((parameter ?? 0) * 100 / 256));
    }
    return accuracy;
  }

  // The one accuracy roll (BattleCommand_CheckHit), hooked as battle.accuracy --
  // the same hook BattleState:accuracyRoll calls on Gen 1, with the same ctx
  // keys: `move`, `user`, `target` and the rng, so a mod that makes a move never
  // miss reads the same fields it did on Red.  `ruleset` has no Gen 2
  // counterpart and is absent rather than invented; `accuracy` (the byte the
  // roll is actually made against, after Bright Powder) and `moveId` are Gen 2
  // additions.  The ctx table is built only when a chain is installed.
  // Lua: Battle.lua:2279
  accuracyRoll(def: any, attacker: any, defender: any, accuracy?: number): any {
    accuracy = accuracy ?? (def ? def.accuracy : undefined);
    if (Runtime.wantsHook("battle.accuracy")) {
      return Runtime.call("battle.accuracy", (c: any) => {
        return c.battle.vanillaAccuracyRoll(c.accuracy, c.user, c.target);
      }, { battle: this, move: def, moveId: def ? def.id : undefined,
           user: attacker, target: defender, accuracy,
           rng: this.roller(), random: this.random });
    }
    return this.vanillaAccuracyRoll(accuracy, attacker, defender);
  }

  // Lua: Battle.lua:2291
  vanillaAccuracyRoll(accuracy: number | undefined, attacker: any, defender: any): boolean {
    let acc = this.stages[this.sideOf(attacker)].accuracy;
    let eva = this.stages[this.sideOf(defender)].evasion;
    // engine/battle/effect_commands.asm:1786
    if (truthy(defender) && truthy(this.volatile(defender).identified)
        && (eva ?? 0) >= (acc ?? 0)) {
      acc = 0;
      eva = 0;
    }
    return Damage.rollHit(this.moveAccuracy(accuracy, defender), acc, eva,
      this.random);
  }

  // BattleCommand_StatDown's SUBSTATUS_MIST arm (a GUARD SPEC): a drop the FOE
  // aims at the holder answers ProtectedByMistText and changes nothing.  The
  // holder's own drops are not Mist's business, so self-targeted changes pass
  // straight through.
  // Lua: Battle.lua:2307
  changeStageAgainstMist(attacker: any, target: any, stat: string, stages: number): any {
    if (target !== attacker && (stages ?? 0) < 0
        && truthy(this.volatile(target).mist)) {
      this.emit({ kind: "message",
        text: Strings.get("%s's protected by MIST.", this.monName(target)) });
      return false;
    }
    return this.changeStage(target, stat, stages);
  }

  // SwitchOutMon / PokeBallEffect's reload: the copy Transform wrote lives in
  // battle ram on the cart, so it never survives the mon leaving the field.
  // Called from Battle:clearVolatile (every switch, and CleanUpBattleRAM at the
  // end of the battle) and from Battle:caught, which is the catch's own reload.
  // Returns whether anything was restored.
  // Lua: Battle.lua:2456
  untransform(mon: any): boolean {
    const state = truthy(mon) ? mon.volatile : undefined;
    // MIMIC's copy lives in the battle struct only (move_effects/mimic.asm
    // writes wBattleMonMoves, not the party), so whatever reloads that struct
    // puts the MIMIC slot back -- the same routes that end a Transform.  First,
    // so a Mimic made while transformed lands back on the transformed moves
    // the Transform restore then replaces.
    if (truthy(state) && truthy(state.preMimic)) {
      mon.moves = state.preMimic;
      delete state.preMimic;
    }
    const before = truthy(state) ? state.preTransform : undefined;
    if (!truthy(before)) return false;
    mon.species = before.species;
    mon.types = before.types;
    mon.moves = before.moves;
    mon.shiny = before.shiny;
    // The stat table is written through in place (a mon's `stats` is handed
    // around by reference), so the five copied numbers are put back one by one.
    const stats = mon.stats;
    if (truthy(stats)) {
      for (const key of Object.keys(before.stats)) stats[key] = before.stats[key];
    }
    delete state.preTransform;
    delete state.transformed;
    return true;
  }

  // pokecrystal/engine/battle/core.asm:8294
  // Lua: Battle.lua:2476
  pinIdentity(mon: any): boolean {
    const state = truthy(mon) && truthy(mon.volatile) ? mon.volatile.preTransform : undefined;
    if (!truthy(state)) return false;
    this.emit({ kind: "identity", side: this.sideOf(mon), mon,
      species: mon.species, partySpecies: state.species });
    return true;
  }

  // BattleCommand_TrapTarget's .Traps table, one line per move: target first,
  // user second.  FIRE_SPIN and WHIRLPOOL share the plain WasTrappedText
  // fallback in the caller.
  // Lua: Battle.lua:2685
  static TRAP_TEXT: Record<string, (target: string, user: string) => string> = {
    BIND: (target: string, user: string): string => {
      return Strings.get("%s used BIND on %s!", user, target);
    },
    WRAP: (target: string, user: string): string => {
      return Strings.get("%s was WRAPPED by %s!", target, user);
    },
    CLAMP: (target: string, user: string): string => {
      return Strings.get("%s was CLAMPED by %s!", target, user);
    },
  };

  // BattleCommand_Screen (effect_commands.asm:6100): one wPlayerScreens bit
  // and a five-turn count per side; the second cast fails while the first is
  // still up.
  // Lua: Battle.lua:2700
  static SCREEN_TURNS = 5;

  // -------------------------------------------------------- the move effects
  //
  // The three tables above as records, in the shape src/mods/Schemas.lua's
  // `move_effects` registry validates (Battle.lua:3020-3044).
  //
  //   primary    the effect runs INSTEAD of the damage path.  Both the
  //              state-setting commands above (`run`) and the zero-power status
  //              moves (`status`) are primary; which one a record is is which
  //              field it carries.
  //   secondary  a side-effect rolled against the move's effect chance after a
  //              hit that already landed.
  //
  // `run` is the Gold signature fn(battle, attacker, defender, def, moveId,
  // sureHit), the same six arguments useMove has always dispatched on.
  // `status` is the name the effect writes into mon.status.  The fold that
  // fills this runs after the class (module level).
  // Lua: Battle.lua:3045
  static MOVE_EFFECT_RECORDS: Record<string, any> = {};

  // vanilla registrations, engine-owned (Schemas.ENGINE), so a mod's register of
  // one of these ids collides the way it does on Red and has to say override.
  //
  // MOVE_EFFECT_RECORDS only carries the effects that have a standalone
  // handler above; every other effect id `data.moves` actually uses gets a
  // bare kind="full" marker so Schemas.lua's `moves.effect` cross-check sees
  // the complete id space, while staying a no-op at both of
  // moveEffectRecordFor's call sites (a record with no run/status is a miss).
  // Brian reads `data.moves` with rawget so an unread DatasetViews root stays
  // unread; there are no lazy views here, so it is a plain read.
  // Lua: Battle.lua:3083
  static registerMoveEffectsInto(registry: any, data: any, owner: any): void {
    for (const id of Object.keys(Battle.MOVE_EFFECT_RECORDS)) {
      registry.register(id, Battle.MOVE_EFFECT_RECORDS[id], owner);
    }
    const moves = truthy(data) ? data.moves : undefined;
    if (truthy(moves)) {
      // RomExtractorGen2:extractMoves seeds `out` with `generation`/`source`
      // alongside the move records themselves, so a bare `pairs(moves)` walks
      // those two non-record entries too; and `effect` falls back to the raw
      // effect BYTE (a number) when the ROM's value has no name, so it can be
      // a non-string even on a real record -- registry:register asserts a
      // string id.
      for (const move of Object.values(moves) as any[]) {
        const effect = typeof move === "object" && move !== null ? move.effect : false;
        if (typeof effect === "string" && effect !== "" && registry.get(effect) == null) {
          registry.register(effect, { kind: "full" }, owner);
        }
      }
    }
  }

  // the merged `move_effects` record for an effect id, the module's own when no
  // loader ran; a plain function over `data` for the same reason
  // Battle.statusRecordFor is one
  // Lua: Battle.lua:3112
  static moveEffectRecordFor(data: any, effect: any): any {
    if (effect == null) return undefined;
    const merged = truthy(data) ? data.gen2MoveEffects : undefined;
    const own = truthy(merged) ? merged[effect] : undefined;
    return truthy(own) ? own : Battle.MOVE_EFFECT_RECORDS[effect];
  }

  // ------------------------------------------------------------ the statuses
  //
  // Gold's persistent conditions as records, in the shape src/mods/Schemas.lua's
  // `statuses` registry validates (Battle.lua:3118-3162).  The table is
  // assigned after the class: its records read Battle's own constants.
  // Lua: Battle.lua:3163
  static STATUSES: Record<string, StatusRecord>;

  // beforeMovePriority above this runs ahead of the flinch/confusion block,
  // at or below after it -- CheckPlayerTurn's order, and the same constant
  // src/battle/Status.lua uses for the Gen 1 gauntlet.
  // Lua: Battle.lua:3278
  static VOLATILE_PRIORITY = 20;

  // vanilla registrations, engine-owned (Schemas.ENGINE), so a mod's register of
  // one of these ids collides the way it does on Red and has to say override
  // Lua: Battle.lua:3282
  static registerStatusesInto(registry: any, _data: any, owner: any): void {
    for (const id of Object.keys(Battle.STATUSES)) {
      registry.register(id, Battle.STATUSES[id], owner);
    }
  }

  // Kept as the derived view of the records: src/core/gen2/ItemEffects.lua's
  // cross-file contract (every name Battle can write into mon.status resolves to
  // a heal class) is checked against this table, and building it from STATUSES
  // is what stops the two from drifting.  Filled after the class.
  // Lua: Battle.lua:3292
  static STATUS_TEXT: Record<string, string> = {};

  // The vanilla records historically expose suffixes because mods can add the
  // same shape.  Keep that API, but use complete templates for the built-ins so
  // translators can move the battler name instead of being forced to prepend it.
  // Lua: Battle.lua:3300
  static STATUS_INFLICT_TEMPLATES: Record<string, string> = {
    sleep: Strings.source("%s fell asleep!"),
    poison: Strings.source("%s was poisoned!"),
    toxic: Strings.source("%s was badly poisoned!"),
    paralyze: Strings.source("%s is paralyzed! It may be unable to move!"),
    burn: Strings.source("%s was burned!"),
    freeze: Strings.source("%s was frozen solid!"),
    confuse: Strings.source("%s became confused!"),
  };

  // Lua: Battle.lua:3310
  static STATUS_RESIDUAL_TEMPLATES: Record<string, string> = {
    poison: Strings.source("%s is hurt by poison!"),
    toxic: Strings.source("%s is hurt by poison!"),
    burn: Strings.source("%s is hurt by its burn!"),
  };

  // Lua: Battle.lua:3316
  static STATUS_RESIDUAL_SUFFIXES: Record<string, string> = {
    poison: Strings.source(" is hurt by poison!"),
    toxic: Strings.source(" is hurt by poison!"),
    burn: Strings.source(" is hurt by its burn!"),
  };

  // The merged `statuses` record for a status id, the module's own when no
  // loader ran -- src/battle/BattleState.lua:effectRecord is the Gen 1 twin.
  // A plain function over `data` rather than a method on purpose: the tests
  // drive canAct and tickStatus against hand-built actor stubs that carry a mon
  // and an emit and nothing else, and a lookup that needed a method would make
  // every one of those stubs implement it.
  // Lua: Battle.lua:3328
  static statusRecordFor(data: any, status: any): StatusRecord | undefined {
    if (status == null) return undefined;
    const merged = truthy(data) ? data.gen2Statuses : undefined;
    const own = truthy(merged) ? merged[status] : undefined;
    return truthy(own) ? own : Battle.STATUSES[status];
  }

  // The one stat this mon's status cuts, applied.  Burn halves Attack and
  // paralysis quarters Speed on the cart; both come off statPenalty so a mod
  // status cuts a stat through the same seam.
  // Lua: Battle.lua:3337
  static statusPenaltyFor(data: any, mon: any, stat: string, value: number): number {
    const record = Battle.statusRecordFor(data, truthy(mon) ? mon.status : undefined);
    const penalty = truthy(record) ? record!.statPenalty : undefined;
    if (!truthy(penalty) || penalty!.stat !== stat) return value;
    return Math.max(1, Math.floor(value / Math.max(1, penalty!.div ?? 1)));
  }

  // engine/battle/effect_commands.asm:6325
  // Lua: Battle.lua:3345
  safeguarded(mon: any): boolean {
    return (this.screens[this.sideOf(mon)].safeguard ?? 0) > 0;
  }

  // engine/battle/effect_commands.asm:1305
  // Lua: Battle.lua:3350
  matchupsAgainst(defender: any): any {
    const chart = this.data.type_chart;
    const rows = truthy(chart) ? chart.matchups : undefined;
    if (!truthy(rows) || !truthy(defender)) return rows;
    if (!truthy(this.volatile(defender).identified)) return rows;
    const skipped = chart.foresightMatchups;
    if (!truthy(skipped) || skipped.length === 0) return rows;
    if (!truthy(this.identifiedMatchups)) {
      const drop: Record<string, boolean> = {};
      for (const row of skipped) {
        drop[tostring(row.attacker) + "/" + tostring(row.defender)] = true;
      }
      const out: any[] = [];
      for (const row of rows) {
        if (!drop[tostring(row.attacker) + "/" + tostring(row.defender)]) {
          out.push(row);
        }
      }
      this.identifiedMatchups = out;
    }
    return this.identifiedMatchups;
  }

  // `source` is the battler that inflicted it, carried only so
  // battle.status_inflicted can name it the way Gen 1's does.
  // BattleCommand_Paralyze and BattleCommand_Poison refuse on a zero matchup,
  // and the poison pair also refuses a POISON-type target: effect_commands.asm
  // :5788 (paralyze), :3671 (poison), :3646 / :4019 (the secondary arms).
  // Sleep, confusion and stat changes are deliberately not gated.
  // Lua: Battle.lua:3379
  statusRefusedByType(defender: any, moveType: string | undefined, status: string): boolean {
    if (!(status === "paralyze" || status === "poison" || status === "toxic")) {
      return false;
    }
    const types: string[] = this.battleTypes(defender);
    if (truthy(moveType)) {
      const matchups = this.matchupsAgainst(defender);
      if (Damage.typeMultiplier(moveType, types, matchups) === 0) return true;
    }
    if (status === "poison" || status === "toxic") {
      for (const t of types) {
        if (t === "POISON") return true;
      }
    }
    return false;
  }

  // Lua: Battle.lua:3396
  applyStatus(mon: any, status: string, source?: any): boolean {
    if ((mon.hp ?? 0) <= 0) return false;
    // Confusion is SUBSTATUS_CONFUSED on the cart, not a status byte: it lives
    // in the volatile beside the major status, so a confused mon can still be
    // burned and a switch shakes the confusion off.
    if (status === "confuse") return this.applyConfusion(mon, undefined, source);
    // engine/battle/effect_commands.asm:6338
    if (truthy(source) && this.sideOf(source) !== this.sideOf(mon)
        && this.safeguarded(mon)) {
      this.emit({ kind: "message",
        text: Strings.get("%s is protected by SAFEGUARD!", this.monName(mon)) });
      return false;
    }
    // One major status at a time.
    if (truthy(mon.status)) {
      this.emit({ kind: "message", text: Strings.get("But it failed!") });
      return false;
    }
    mon.status = status;
    // Through the merged record: onInflict is where the sleep roll and the Toxic
    // counter live, so a mod status can arm its own counter here too.
    const record = Battle.statusRecordFor(this.data, status);
    if (truthy(record) && truthy(record!.onInflict)) record!.onInflict!(this, mon);
    const template = Battle.STATUS_INFLICT_TEMPLATES[status];
    const vanilla = Battle.STATUSES[status];
    let text: string;
    if (truthy(template) && truthy(vanilla)
        && (!truthy(record) || record!.inflictText === vanilla!.inflictText)) {
      text = Strings.get(template!, this.monName(mon));
    } else {
      text = Strings.get("%s%s", this.monName(mon),
        Strings.get((truthy(record) ? record!.inflictText : undefined) ?? " is afflicted!"));
    }
    this.emit({ kind: "status", side: this.sideOf(mon), status,
      text });
    // battle.status_inflicted, the payload src/battle/StatusRegistry.lua emits on
    // Gen 1, for the major status only -- confusion is a substatus in both
    // generations and Gen 1 raises nothing for it either.  The `status` VALUE is
    // Gen 2's own spelling ("poison", "burn", "paralyze"), not Gen 1's PSN/BRN
    // code.
    Runtime.emit("battle.status_inflicted", {
      battle: this, target: mon, status, source,
      side: this.sideOf(mon),
    });
    return true;
  }

  // BattleCommand_FinishConfusingTarget (effect_commands.asm:5734): the
  // SUBSTATUS_CONFUSED bit plus a 2-5 turn count (`and %11` plus two).
  // `turns` is the Berserk Gene's override: HandleBerserkGene sets the bit
  // WITHOUT writing the count (core.asm:301), and the zero count decrements
  // through zero on the cart -- an effectively permanent lock, modelled here
  // as 256 turns.  HELD_PREVENT_CONFUSE on the target blocks it outright.
  // Lua: Battle.lua:3450
  static BERSERK_GENE_CONFUSE_TURNS = 256;

  // Lua: Battle.lua:3452
  applyConfusion(mon: any, turns?: number, source?: any): boolean {
    if ((mon.hp ?? 0) <= 0) return false;
    // engine/battle/effect_commands.asm:6338
    if (truthy(source) && this.sideOf(source) !== this.sideOf(mon)
        && this.safeguarded(mon)) {
      this.emit({ kind: "message",
        text: Strings.get("%s is protected by SAFEGUARD!", this.monName(mon)) });
      return false;
    }
    const state = this.volatile(mon);
    if ((state.substitute ?? 0) > 0) return false;
    const [held] = this.heldEffect(mon, "confuse");
    if (held === "HELD_PREVENT_CONFUSE") return false;
    if (truthy(state.confuseCount)) {
      this.emit({ kind: "message",
        text: Strings.get("%s's already confused!", this.monName(mon)) });
      return false;
    }
    state.confuseCount = turns ?? (rand(this.random, 4) + 2);
    const record = Battle.statusRecordFor(this.data, "confuse");
    const template = Battle.STATUS_INFLICT_TEMPLATES.confuse!;
    const vanilla = Battle.STATUSES.confuse!;
    this.emit({ kind: "message",
      text: (!truthy(record) || record!.inflictText === vanilla.inflictText)
        ? Strings.get(template, this.monName(mon))
        : Strings.get("%s%s", this.monName(mon),
          Strings.get((truthy(record) ? record!.inflictText : undefined) ?? " became confused!")) });
    return true;
  }

  // ResidualDamage picks the anim off the status byte, ANIM_BRN for a burn and
  // ANIM_PSN for either poison (engine/battle/core.asm:958-976).
  // Lua: Battle.lua:3484
  static RESIDUAL_ANIM: Record<string, string> = {
    burn: "ANIM_BRN", poison: "ANIM_PSN", toxic: "ANIM_PSN",
  };

  // ResidualDamage: burn and poison chip damage, through the merged record's
  // `residual`.  The record computes and advances its own counter; the emit pair
  // stays here because the event shape belongs to this engine, not to the status.
  // Lua: Battle.lua:3491
  tickStatus(mon: any): void {
    if ((mon.hp ?? 0) <= 0 || !truthy(mon.status)) return;
    const record = Battle.statusRecordFor(this.data, mon.status);
    const residual = truthy(record) ? record!.residual : undefined;
    if (!truthy(residual)) return;
    const maxHp = mon.maxHp ?? mon.stats?.hp ?? 1;
    const name = this.monName(mon);
    // Lua's two return values arrive as a [damage, text] pair.
    const [damage, text] = residual!(this, mon, maxHp) ?? [];
    if (!truthy(damage) || (damage as number) <= 0) return;
    mon.hp = Math.max(0, mon.hp - (damage as number));
    const template = Battle.STATUS_RESIDUAL_TEMPLATES[mon.status];
    const suffix = Battle.STATUS_RESIDUAL_SUFFIXES[mon.status];
    this.emit({ kind: "message", text: truthy(template) && text === suffix
      ? Strings.get(template!, name)
      : Strings.get("%s%s", name, Strings.get(text ?? " is hurt!")) });
    // Call_PlayBattleAnim_OnlyIfVisible runs on the sufferer's own turn
    // (core.asm:970-976); a mod status the cart never had gets nothing.
    this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
      hp: mon.hp, anim: Battle.RESIDUAL_ANIM[mon.status] ?? false,
      animSide: this.sideOf(mon) });
  }
  // ---- Battle.lua PART C (Lua lines 3514-5488): faints, experience, forget/learn,
  // switching, obedience, items, running, enemy AI hooks, the turn driver, the
  // end-of-turn ticks, held items, forced replacement and the link signature.
  //
  // Party and move-slot INDICES stay the Lua's 1-based numbers wherever they are
  // values (playerIndex, enemyIndex, participants keys, action.index, event.index,
  // the forget slot, bench[].index); only the array reads subtract one
  // (`this.party[index - 1]`), so events and actions carry exactly the Lua's values.

  // TryEnemyFlee's two thresholds: `percent` is `* $ff / 100` (macros/data.asm),
  // so 50*255/100 = 127, +1; 10*255/100 = 25, +1.
  static OFTEN_FLEE_ROLL = 128; // 50 percent + 1
  static SOMETIMES_FLEE_ROLL = 26; // 10 percent + 1

  // HandleScreens (engine/battle/core.asm:1564): each side's five-turn counts
  // tick down and the screen falls the turn its count reaches zero.
  // Lua: Battle.lua:5197
  static SCREEN_SIDE_LABEL: Record<string, string> = {
    player: Strings.source("Your"),
    enemy: Strings.source("Enemy"),
  };
  // Lua: Battle.lua:5200
  static SCREEN_FALL_TEXT: Record<string, string> = {
    lightScreen: Strings.source("%s POKéMON's LIGHT SCREEN fell!"),
    reflect: Strings.source("%s POKéMON's REFLECT faded!"),
  };

  // Held items with an end-of-turn effect.
  //
  //   HELD_LEFTOVERS  heals maxHP / 16 every turn (HandleLeftovers)
  //   HELD_BERRY      heals its parameter once the holder drops below half
  //                   (HandleHealingItems), and is consumed
  //   HELD_HEAL_*     cures the status it names, and is consumed
  //
  // Confusion is a volatile, not a status byte, so HELD_HEAL_CONFUSION is not
  // in this table: its cure (and HELD_HEAL_STATUS's catch-all) reads the
  // confuseCount volatile in tickHeldItem's own arm below.
  // Lua: Battle.lua:5269
  static HELD_STATUS_CURES: Record<string, string> = {
    HELD_HEAL_POISON: "poison",
    HELD_HEAL_SLEEP: "sleep",
    HELD_HEAL_BURN: "burn",
    HELD_HEAL_FREEZE: "freeze",
    HELD_HEAL_PARALYZE: "paralyze",
  };

  // Lua: Battle.lua:5378
  static LINK_STAGES: string[] = ["attack", "defense", "speed", "specialAttack",
    "specialDefense", "accuracy", "evasion"];

  // Lua: Battle.lua:5381
  static LINK_VOLATILE: string[] = [
    "attract",
    "bideStored", "bideTurns", "chargeMove", "confuseCount", "curled", "cursed",
    "disabled", "disabledTurns", "encore", "encoreTurns", "endure", "flinched",
    "focusEnergy", "futureSight", "futureSightDamage", "futureSightSide",
    "identified", "lastMove", "leechSeed", "lockOn", "mist", "perish", "protect",
    "protectCount", "rage", "rampCount", "rampMove", "rampageMove",
    "rampageTurns", "recharge", "rolloutLock", "substitute", "tookThisTurn",
    "transformed", "trapsTarget", "turnsTaken", "vanished", "wrapCount",
    "wrapMoveId", "xAccuracy",
  ];

  // Lua: Battle.lua:5393
  static LINK_SCREENS: string[] = ["lightScreen", "reflect", "safeguard"];

  // Lua: Battle.lua:5485-5486 (assigned after the class, in the post fragment).
  static Damage: any;
  static Mon: any;

  // Lua: Battle.lua:3514
  resolveFaints(): boolean {
    // engine/battle/core.asm:2551-2556, :7116-7130, :3033-3037
    if ((this.player.hp ?? 0) <= 0 && this.participantsCleared !== this.player) {
      this.participantsCleared = this.player;
      if (truthy(this.playerIndex)) delete this.participants[this.playerIndex];
    }

    if ((this.enemy.hp ?? 0) <= 0) {
      if (truthy(this.linkBattle) && this.enemyFaintAnnounced === this.enemy) {
        this.faintInterrupt = true;
        // Link: the player's own faint this round is still asked for (below),
        // so both consoles pick their replacements at once -- each waiting on
        // the other's pick first was a deadlock on a double faint.
        if ((this.player.hp ?? 0) > 0) return false;
        return this.resolvePlayerFaint();
      }
      this.enemyFaintAnnounced = this.enemy;
      const template = truthy(this.wild)
        ? Strings.source("Wild %s fainted!")
        : Strings.source("%s fainted!");
      this.emit({ kind: "faint", side: "enemy",
        text: Strings.get(template, this.monName(this.enemy)) });
      // battle.fainted, the payload BattleState:onFaint emits on Gen 1.
      // `battler` is the mon itself here: Gen 2's engine has no battler wrapper.
      Runtime.emit("battle.fainted", { battle: this, battler: this.enemy,
        side: this.sideRecord(this.enemy) });
      this.awardExperience(this.enemy);
      const nextIndex = Battle.firstHealthy(this.enemyParty);
      if (!truthy(nextIndex) && truthy(this.linkBattle) && !truthy(Battle.firstHealthy(this.party))) {
        // a link battle's last two mons down in the same round: a draw on
        // both consoles (not a win on each)
        if (this.faintAnnounced !== this.player && (this.player.hp ?? 0) <= 0) {
          this.faintAnnounced = this.player;
          this.emit({ kind: "faint", side: "player",
            text: Strings.get("%s fainted!", this.monName(this.player)) });
        }
        this.emit({ kind: "message", text: Strings.get("Tied against %s!",
          this.trainer?.name ?? "TRAINER") });
        this.endBattle("draw");
        return true;
      }
      if (!truthy(nextIndex)) {
        if (truthy(this.trainer)) {
          this.emit({ kind: "message", text: Strings.get("%s was defeated!",
            this.trainer.name ?? "TRAINER") });
          this.printWinLossText("win");
          this.awardPrizeMoney();
        }
        // CheckPayDay, on the win arm only (engine/battle/core.asm:7971-7976,
        // :8014-8042).
        const coins = Prize.payDay(this.save, this.payDay, this.amuletCoin);
        if (truthy(coins)) {
          this.emit({ kind: "money", text: Prize.payDayMessage(coins,
            this.save.player && this.save.player.name) });
        }
        this.payDay = undefined;
        this.endBattle("win");
        return true;
      }
      if (truthy(this.linkBattle)) {
        this.pendingEnemySwitch = true;
        this.faintInterrupt = true;
        // (the same: a player faint this round is asked for now)
        if ((this.player.hp ?? 0) > 0) return false;
        return this.resolvePlayerFaint();
      }
      const previous = this.enemy;
      this.clearVolatile(this.enemy);
      this.enemyIndex = nextIndex;
      this.enemy = this.enemyParty[nextIndex! - 1];
      // ResetEnemyBattleVars (engine/battle/core.asm:3016) and NewEnemyMonStatus
      // clear the move selection and the substatus bytes for the mon coming IN,
      // so a replacement never inherits anything from its last stint.
      this.clearVolatile(this.enemy);
      this.stages.enemy = Battle.newStages();
      // `replacement` marks HandleEnemySwitch's send, the only one EnemySwitch
      // can offer a shift on (engine/battle/core.asm:2241-2278).
      this.emit({ kind: "send", side: "enemy", mon: this.enemy,
        replacement: true,
        hp: this.enemy.hp ?? 0, status: this.enemy.status ?? false,
        level: this.enemy.level, experience: this.enemy.experience,
        text: Battle.sentOutText(truthy(this.trainer) ? (this.trainer.name ?? "Foe") : "Foe",
          this.monName(this.enemy)) });
      Runtime.emit("battle.battler_switched", {
        battle: this, side: this.sideRecord(this.enemy), battler: this.enemy,
        previous,
      });
      this.breakTrapsOnSend(this.enemy);
      // core.asm runs SpikesDamage on every send-out; the faint replacement
      // is not exempt.
      this.spikesDamage(this.enemy);
      // Battle_PlayerFirst reaches HandleEnemyMonFaint with `jp`, not `call`
      // (engine/battle/core.asm:872), so the round's attack phase is over: the
      // mon that just walked in never answers, and the move that was queued for
      // the one it replaced is never spent.  Battle:takeTurn reads this.
      this.faintInterrupt = true;
      return false;
    }

    if ((this.player.hp ?? 0) <= 0) return this.resolvePlayerFaint();
    return false;
  }

  /** resolveFaints' player arm: the faint announced once, then the choice
   *  of the next mon (or the loss). */
  resolvePlayerFaint(): boolean {
    {
      // Announce a faint ONCE.  This branch emits `choose-switch` and waits for
      // the caller to pick, so the caller calls back in with the same mon still
      // at 0 HP; `faintHappiness` must be charged once per faint
      // (engine/battle/core.asm, HandlePlayerMonFaint runs its happiness arm
      // once).  Keyed on the mon itself, so the next one in announces normally.
      if (this.faintAnnounced !== this.player) {
        this.faintAnnounced = this.player;
        this.emit({ kind: "faint", side: "player",
          text: Strings.get("%s fainted!", this.monName(this.player)) });
        Runtime.emit("battle.fainted", { battle: this, battler: this.player,
          side: this.sideRecord(this.player) });
        this.faintHappiness(this.player);
      }
      const nextIndex = Battle.firstHealthy(this.party);
      if (!truthy(nextIndex)) {
        this.emit({ kind: "message",
          text: Strings.get("You have no more POKéMON!") });
        // LostBattle (engine/battle/core.asm:2763-2782): only BATTLETYPE_CANLOSE
        // reaches PrintWinLossText on a loss; every other loss whites out.
        if (this.battleType === Battle.BATTLETYPE_CANLOSE) {
          this.printWinLossText("lose");
        }
        this.endBattle("lose");
        return true;
      }
      // The player picks the replacement; the caller drives that with :switch.
      // Asked for ONCE: takeTurn reaches resolveFaints up to three times in a
      // round, and HandlePlayerMonFaint runs ForcePlayerMonChoice a single time
      // (engine/battle/core.asm:2543).  Battle:switch releases the guard.
      if (!truthy(this.pendingSwitch)) {
        this.pendingSwitch = true;
        this.emit({ kind: "choose-switch" });
      }
      // Same `jp`, not `call`, as the enemy arm above (core.asm:874): whatever
      // is left of the attack phase is abandoned.
      this.faintInterrupt = true;
      return false;
    }
    return false;
  }

  // WinTrainerBattle (engine/battle/core.asm:2310-2323), LostBattle's .canlose
  // arm (:2769-2782), PrintWinLossText (home/trainers.asm:230)
  // Lua: Battle.lua:3651
  printWinLossText(result: string): void {
    const trainer = this.trainer;
    if (!truthy(trainer)) return;
    // The DEBUG_BATTLE_F skip sits in front of PrintWinLossText alone, behind
    // the slide (engine/battle/core.asm:2310, :2320-2323).
    // The CANLOSE loss arm runs ClearBox first (:2770-2773).
    this.emit({ kind: "trainer-return", cleared: result === "lose" ? true : undefined });
    const text = (result === "lose") ? trainer.lossText : trainer.winText;
    if (typeof text !== "string" || text === "") return;
    // FarPrintText prints the pointer alone: no trainer-name tag in front of
    // it, unlike Gen 1's TrainerEndBattleText (pokered home/trainers.asm:355).
    this.emit({ kind: "win-text", text });
  }

  // WinTrainerBattle's money arm (engine/battle/core.asm:2310-2323)
  // Lua: Battle.lua:3666
  awardPrizeMoney(): any {
    const save = this.save;
    if (!(truthy(save) && truthy(save.player))) return undefined;
    const award = Prize.award(save, {
      baseMoney: truthy(this.trainer) ? this.trainer.baseMoney : undefined,
      // wCurPartyLevel, left behind by ReadTrainerParty: the LAST row of the
      // roster, whatever order the mons actually fainted in.
      level: Prize.rewardLevel(this.enemyParty),
      amuletCoin: this.amuletCoin,
    });
    this.prize = award;
    this.emit({ kind: "money", award,
      text: Prize.message(award, truthy(save.player) ? save.player.name : undefined) });
    return award;
  }

  // UpdateFaintedPlayerMon (engine/battle/core.asm), the happiness half.  Runs
  // on EVERY player faint, not only the whiteout, and picks between two events
  // by how outclassed the mon was:
  //
  //   ld a, [wBattleMonLevel] / add 30 / ld b, a
  //   ld a, [wEnemyMonLevel]  / cp b   / jr c, .got_param
  //
  // `jr c` keeps HAPPINESS_FAINTED while the foe is BELOW yourLevel + 30.
  // Lua: Battle.lua:3693
  faintHappiness(mon: any): void {
    if (!truthy(mon)) return;
    let event = "FAINTED";
    if ((this.enemy.level ?? 0) >= (mon.level ?? 0) + 30) {
      event = "BEATENBYSTRONGFOE";
    }
    // ChangeHappiness runs against the party slot, and this mon IS that slot's
    // table, so a fainted mon is still the thing that loses the point.
    Happiness.change(mon, event);
  }

  // GiveExperiencePoints' traded check: the mon's OT id against wPlayerID.  A
  // mon with no recorded OT (the port's native catches and gifts) is the
  // player's own.
  // Lua: Battle.lua:3707
  isOutsider(mon: any): boolean {
    const playerId = truthy(this.save) && truthy(this.save.player) ? this.save.player.id : undefined;
    if (mon.traded === true) return true;
    if (mon.otId == null || playerId == null) return false;
    return mon.otId !== playerId;
  }

  // One pass of GiveExperiencePoints over `recipients` (party indices, 1-based).
  // `count` is the pass's own divisor -- the participant count for the first
  // pass, the holder count for the EXP.SHARE pass -- and `halved` is whether
  // any Share holder taxed the whole pool.
  //
  // `silent` suppresses only the GainedText line (the battle.exp_award seam);
  // the cart's own two passes never pass it.
  // Lua: Battle.lua:3726
  giveExperiencePass(loser: any, def: any, recipients: number[], count: number,
    halved: boolean, silent?: boolean): void {
    for (const index of recipients) {
      const mon = this.party[index - 1];
      if (truthy(mon) && (mon.hp ?? 0) > 0 && !truthy(mon.isEgg)) {
        const traded = this.isOutsider(mon);
        // `cp LUCKY_EGG` on the mon's item byte: by id, not held effect.
        const luckyEgg = mon.item === "LUCKY_EGG";
        // exp.gain, the same hook src/battle/Experience.lua calls on Gen 1 and
        // with the same ctx keys; `halved` and `luckyEgg` ride beside them.
        let amount: number;
        if (Runtime.wantsHook("exp.gain")) {
          amount = Runtime.call("exp.gain", (c: any) => {
            return Mon.experienceGain(c.defeatedDef, c.level, c.participants,
              c.isTrainer, { halved: c.halved, traded: c.traded,
                luckyEgg: c.luckyEgg });
          }, { defeatedDef: def, level: loser.level,
            isTrainer: this.trainer != null, participants: count,
            traded, mon,
            halved, luckyEgg,
            battle: this, loser });
        } else {
          amount = Mon.experienceGain(def, loser.level, count,
            this.trainer != null, { halved, traded,
              luckyEgg });
        }
        // Stat exp first: GiveExperiencePoints awards it before the exp points,
        // so a mon that levels on this kill recalculates its stats with the
        // effort it just earned already counted.  Pokerus (or the immune marker
        // a cured mon keeps) doubles it.
        Mon.gainStatExp(mon, def, count, Pokerus.doublesStatExp(mon), halved);
        const result: any = Mon.gainExperience(mon, amount, this.data);
        // battle.exp_gained, the payload BattleState:awardExp emits on Gen 1.
        // `levels` is the LIST of levels reached, built only when something is
        // listening.
        if (Runtime.wants("battle.exp_gained")) {
          const levels: number[] = [];
          for (let level = (result.from ?? 0) + 1; level <= (result.to ?? 0); level++) {
            levels.push(level);
          }
          Runtime.emit("battle.exp_gained", {
            battle: this, mon, gained: amount, levels,
            // Gen 2 addition: the party slot, which is what the engine's own
            // experience event is keyed by.
            index,
          });
        }
        if (!truthy(silent)) {
          this.emit({ kind: "experience", index, amount,
            // BoostedExpPointsText, keyed on the traded arm alone.
            text: traded
              ? Strings.get("%s gained a boosted %d EXP. Points!",
                this.monName(mon), amount)
              : Strings.get("%s gained %d EXP. Points!", this.monName(mon), amount) });
        }
        if (result.levels > 0) {
          // "level up happiness mod", the cart's own comment, sitting right
          // after the stat recalc and before the "grew to level" text.  It fires
          // ONCE per exp award however many levels the mon jumped, because
          // ChangeHappiness is outside the level loop.
          Happiness.change(mon, "GAINLEVEL");
          this.emit({ kind: "level", index, level: mon.level,
            text: Strings.get("%s grew to level %d!", this.monName(mon), mon.level),
            sfx: "Sfx_DexFanfare5079", waitSfx: true });
          for (const moveId of result.learned) {
            const [ok, reason, entry] = this.learnPartyMove(mon, moveId);
            const moveDef = this.moveDef(moveId);
            const moveName = (truthy(moveDef) && truthy(moveDef.name)) ? moveDef.name : moveId;
            if (truthy(ok)) {
              // data/text/common_3.asm:119
              this.emit({ kind: "message",
                sfx: "Sfx_DexFanfare5079", waitSfx: true,
                text: Strings.get("%s learned %s!", this.monName(mon), moveName) });
            } else if (reason === "full") {
              // LearnMove's full-moveset arm calls ForgetMove, which asks with
              // AskForgetMoveText (engine/pokemon/learn.asm:29-34, :121-124).
              this.emit({ kind: "choose-forget", index, move: entry,
                moveName });
            }
          }
        }
      }
    }
  }

  // PokeBallEffect's captured tail, the battle half of it: the catch site
  // (src/ui/gen2/BattleState.lua:pushCaught) owns the #DEX, the party and the
  // nickname prompt, and this owns what the BATTLE still has to say about the
  // mon that was just taken off the field.
  //
  //   * the reload.  `.catch_without_fail` puts wTempEnemyMonSpecies into
  //     wCurPartySpecies before the mon is added, so a DITTO that transformed is
  //     caught as a DITTO with its own moves.
  //   * battle.catch_exp.  Vanilla catches never grant exp; a mod can flip the
  //     hook to true to pay out the same award a faint would have.
  //
  // Safe to call more than once: the reload is a no-op once the identity is
  // back, and `caughtHandled` keeps a second call from paying the exp twice.
  // Lua: Battle.lua:3835
  caught(mon?: any): any {
    mon = truthy(mon) ? mon : this.enemy;
    if (truthy(this.caughtHandled)) return mon;
    this.caughtHandled = true;
    this.untransform(mon);
    if (Runtime.wantsHook("battle.catch_exp")
        && truthy(Runtime.call("battle.catch_exp", (_c: any) => false,
          { battle: this }))) {
      this.awardExperience(mon);
    }
    return mon;
  }

  // GiveExperiencePoints, both calls (engine/battle/core.asm:2116/2130): with
  // any live EXP.SHARE holder in the party the enemy's base exp and base
  // stats are halved up front, the participants split the first pass, and a
  // second pass pays every holder -- participant or not, so a holder that
  // fought collects twice.  Holders are found by ITEM id, the way
  // IsAnyMonHoldingExpShare's `cp EXP_SHARE` does, and a fainted holder gets
  // nothing (the pass loop skips fainted mons).
  // Lua: Battle.lua:3855
  awardExperience(loser: any): void {
    if (truthy(this.linkBattle)) return this.resetParticipants();
    const def = this.speciesDef(loser);

    // pairs() + table.sort: sortedKeys gives the same ascending numeric order.
    const participants: number[] = sortedKeys(this.participants).map(Number);

    const holders: number[] = [];
    for (let i = 0; i < this.party.length; i++) {
      const mon = this.party[i];
      if ((mon.hp ?? 0) > 0 && !truthy(mon.isEgg) && mon.item === "EXP_SHARE") {
        holders.push(i + 1);
      }
    }

    const halved = holders.length > 0;
    const vanillaAward = (): void => {
      this.giveExperiencePass(loser, def, participants, participants.length, halved);
      if (halved) {
        this.giveExperiencePass(loser, def, holders, holders.length, true);
      }
    };

    // battle.exp_award, the same hook BattleState:awardExp calls on Gen 1 and
    // with the same ctx: the participant COUNT, the live participants, and an
    // applyShare(mon, split, announce) a mod can call to pay one mon its own
    // share.  `announce` is honoured only when it is actually PASSED, by
    // argument count rather than by value (select("#") in the Lua).
    if (Runtime.wantsHook("battle.exp_award")) {
      const alive: any[] = [];
      for (const index of participants) {
        const mon = this.party[index - 1];
        if (truthy(mon) && (mon.hp ?? 0) > 0) alive.push(mon);
      }
      const applyShare = (mon: any, split?: number, ...rest: any[]): void => {
        const announce = rest[0];
        const silent = rest.length > 0 && !truthy(announce);
        for (let i = 0; i < this.party.length; i++) {
          if (this.party[i] === mon) {
            return this.giveExperiencePass(loser, def, [i + 1],
              Math.max(1, truthy(split) ? split! : 1), halved, silent);
          }
        }
      };
      Runtime.call("battle.exp_award", (_c: any) => vanillaAward(), {
        battle: this, participants: participants.length, alive,
        applyShare, recipients: participants, holders,
        halved, loser,
      });
    } else {
      vanillaAward();
    }

    // GiveExperiencePoints .done falls through ResetBattleParticipants into
    // AddBattleParticipant (engine/battle/core.asm:7116 and :3033).
    this.resetParticipants();
  }

  // pokecrystal/engine/pokemon/learn.asm:88
  // Lua: Battle.lua:3932
  partyMoves(mon: any): any {
    const state = truthy(mon) && truthy(mon.volatile) ? mon.volatile.preTransform : undefined;
    if (truthy(state)) {
      state.moves = truthy(state.moves) ? state.moves : [];
      return state.moves;
    }
    return truthy(mon) ? mon.moves : undefined;
  }

  // Returns Mon.learnMove's [ok, reason, entry] (the Lua's three values).
  // Lua: Battle.lua:3941
  learnPartyMove(mon: any, moveId: any): [boolean, any?, any?] {
    const state = truthy(mon) && truthy(mon.volatile) ? mon.volatile.preTransform : undefined;
    if (!truthy(state)) return Mon.learnMove(mon, moveId, this.data);
    const copied = mon.moves;
    mon.moves = this.partyMoves(mon);
    const [ok, reason, entry] = Mon.learnMove(mon, moveId, this.data);
    state.moves = mon.moves;
    mon.moves = copied;
    return [ok, reason, entry];
  }

  // The answer to a `choose-forget`: drop the move in `slot` (1-based) and put
  // the pending one there, then queue the cart's "forgot X / learned Y" lines.
  // The battle slot aliases the party slot the same way Mimic does, so a mon in
  // play picks up the new move immediately.
  // Lua: Battle.lua:3956
  resolveForget(index: number, slot: number, entry: any, moveName?: string): boolean {
    const mon = this.party[index - 1];
    const moves = this.partyMoves(mon);
    if (!(truthy(mon) && truthy(moves) && truthy(moves[slot - 1]) && truthy(entry))) return false;
    const old = moves[slot - 1];
    const oldDef = this.moveDef(old.id);
    const oldName = (truthy(oldDef) && truthy(oldDef.name)) ? oldDef.name : old.id;
    moves[slot - 1] = entry;
    // Keep the in-play battler's move list pointing at the same table, so a mon
    // that levelled mid-battle fights the rest of it with the new move.
    if (this.player === mon && moves === mon.moves
        && this.player.moves !== mon.moves) {
      this.player.moves = mon.moves;
    }
    // ../pokecrystal/home/text.asm:887-896
    this.emit({ kind: "message", text: Strings.get("1, 2 and…"), textPause: true });
    // engine/pokemon/learn.asm:225-229, data/text/common_3.asm:172-173
    this.emit({ kind: "message", sfx: "Sfx_SwitchPokemon",
      text: Strings.get("Poof! %s forgot %s!", this.monName(mon), oldName) });
    // engine/pokemon/learn.asm:115, data/text/common_3.asm:119
    this.emit({ kind: "message",
      sfx: "Sfx_DexFanfare5079", waitSfx: true,
      text: Strings.get("%s learned %s!", this.monName(mon),
        truthy(moveName) ? moveName : ((truthy(entry) && truthy(entry.id)) ? entry.id : "?")) });
    // The forget path writes the slot itself rather than going through
    // Mon.learnMove, so pokemon.move_learned is raised here too.
    Runtime.emit("pokemon.move_learned", { mon, moveId: entry.id });
    return true;
  }

  // The other answer: keep the four it has.  MoveDidntLearn's line.
  // Lua: Battle.lua:3988
  declineForget(index: number, moveName?: string): void {
    const mon = this.party[index - 1];
    this.emit({ kind: "message", text: Strings.get("%s did not learn %s.",
      truthy(mon) ? this.monName(mon) : "It", truthy(moveName) ? moveName : "the move") });
  }

  // NewBattleMonStatus / the enemy switch tail (core.asm:3864 and 3405): ANY
  // send-out ends BOTH partial traps and drops the CANT_RUN pin that was aimed
  // at the incoming side -- whose holder is the opponent, so it is the
  // opponent's volatile that carries it.
  // Lua: Battle.lua:3998
  breakTrapsOnSend(incoming: any): void {
    for (const mon of [this.player, this.enemy]) {
      if (mon == null) break; // ipairs stops at the first nil
      const state = this.volatile(mon);
      state.wrapCount = undefined;
      state.wrapMove = undefined;
      state.wrapMoveId = undefined;
    }
    const opponent = (incoming === this.player && truthy(this.enemy)) ? this.enemy : this.player;
    this.volatile(opponent).trapsTarget = undefined;
  }

  // TryPlayerSwitch's `.check_trapped` (core.asm:4886): a live wrap on the
  // active mon or the enemy's CANT_RUN pin refuses a VOLUNTARY switch with
  // "can't be recalled!".  The faint replacement path never asks.
  // Lua: Battle.lua:4010
  switchLocked(): boolean {
    if ((this.volatile(this.player).wrapCount ?? 0) > 0) return true;
    return this.volatile(this.enemy).trapsTarget === true;
  }

  // ResetBattleParticipants falls through into AddBattleParticipant
  // (engine/battle/core.asm:3033 and :3037).
  // Lua: Battle.lua:4017
  resetParticipants(): void {
    this.participants = {};
    if (truthy(this.playerIndex)) this.participants[this.playerIndex] = true;
  }

  // EnemySwitch's shift arm zeroes both participant bitfields before PlayerSwitch
  // (engine/battle/core.asm:2959-2961).
  // Lua: Battle.lua:4024
  shiftSwitch(index: number): boolean {
    this.participants = {};
    return this.switch(index);
  }

  // Switch the player's active mon (`index` is the 1-based party slot).  A
  // switch takes the whole turn.
  // Lua: Battle.lua:4030
  switch(index: number): boolean {
    const mon = this.party[index - 1];
    if (!truthy(mon) || (mon.hp ?? 0) <= 0) return false;
    if (mon === this.player) return false;
    // Switching out drops every volatile: the Substitute, the charge, the
    // Rollout ramp and the stat stages all go with it.  The incoming mon starts
    // from an empty area too (NewBattleMonStatus runs at every send-out), so a
    // mon that comes back in carries nothing from its last stint.
    const previous = this.player;
    this.clearVolatile(this.player);
    this.clearVolatile(mon);
    // A mon that comes back (a REVIVE, or a second battle) has to be able to
    // announce its own faint again; see resolveFaints.
    this.faintAnnounced = undefined;
    this.participantsCleared = undefined;
    // ForcePlayerMonChoice has been answered, so the next faint may ask again.
    this.pendingSwitch = undefined;
    this.player = mon;
    this.playerIndex = index;
    this.participants[index] = true;
    this.stages.player = Battle.newStages();
    this.emit({ kind: "send", side: "player", mon,
      hp: mon.hp ?? 0, status: mon.status ?? false,
      level: mon.level, experience: mon.experience,
      text: Strings.get("Go! %s!", this.monName(mon)) });
    // battle.battler_switched, the payload BattleState:resolveSwitch emits on
    // Gen 1: the side record, whoever walked in, and whoever walked out.
    Runtime.emit("battle.battler_switched", {
      battle: this, side: this.sideRecord(mon), battler: mon,
      previous,
    });
    this.breakTrapsOnSend(mon);
    this.checkAmuletCoin(mon);
    this.spikesDamage(mon);
    return true;
  }

  // CheckAmuletCoin (engine/battle/core.asm), which sits in the send-out path
  // rather than in the payout: `ld a, [wBattleMonItem] / GetItemHeldEffect / cp
  // HELD_AMULET_COIN`, then a 1 into wAmuletCoin.  Nothing clears the byte for
  // the rest of the battle.
  // Lua: Battle.lua:4072
  checkAmuletCoin(mon: any): void {
    if (truthy(mon) && mon.item === Prize.AMULET_COIN) this.amuletCoin = true;
  }

  // HandleBerserkGene (engine/battle/core.asm:301).  Checked by ITEM id, not
  // held effect.  The gene is consumed, Attack jumps two stages
  // (BattleCommand_AttackUp2) and the holder is confused -- with no count
  // written on the cart (Battle.BERSERK_GENE_CONFUSE_TURNS).
  // Lua: Battle.lua:4082
  checkBerserkGene(mon: any): boolean {
    if (!truthy(mon) || mon.item !== "BERSERK_GENE" || (mon.hp ?? 0) <= 0) {
      return false;
    }
    const def = this.itemDef(mon.item);
    mon.item = undefined;
    this.emit({ kind: "message",
      text: Strings.get("%s's %s activated!", this.monName(mon),
        (truthy(def) && truthy(def.name)) ? def.name : "BERSERK GENE") });
    this.changeStage(mon, "attack", 2);
    this.applyConfusion(mon, Battle.BERSERK_GENE_CONFUSE_TURNS);
    return true;
  }

  // BattleCommand_CheckObedience's badge ladder: the obedience cap by owned
  // Johto badges.  MAX_LEVEL + 1 for RISINGBADGE means nothing ever disobeys.
  // Lua: Battle.lua:4098
  obedienceLevel(): number {
    if (this.hasBadge("badges", "RISING")) return Mon.MAX_LEVEL + 1;
    if (this.hasBadge("badges", "STORM")) return 70;
    if (this.hasBadge("badges", "FOG")) return 50;
    if (this.hasBadge("badges", "HIVE")) return 30;
    return 10;
  }

  // The cart's `.rand1` / `.rand2`: one byte, re-rolled until it lands under
  // `limit`.  Guarded so an injected test roller that never goes low cannot
  // spin forever; the fallback fold keeps the result in range.
  // Lua: Battle.lua:4109
  rollBelow(limit: number): number {
    for (let i = 1; i <= 128; i++) {
      const roll = rand(this.random, 256);
      if (roll < limit) return roll;
    }
    return mod(rand(this.random, 256), Math.max(1, limit));
  }

  // HitConfusion (engine/battle/effect_commands.asm:613): a typeless 40 power
  // physical hit against the user's OWN Defense -- stat stages and the badge
  // boosts apply through wPlayerStats, but there is no crit, no STAB, no type
  // row and no damage variation; DamageCalc's MIN_DAMAGE floor still holds.
  // Shared by the confusion self-hit and the disobedience self-hit.
  // Lua: Battle.lua:4122
  confusionSelfHit(mon: any): number {
    const stages = this.stages[this.sideOf(mon)];
    let attack = Damage.applyStage(this.battleStat(mon, "attack"),
      stages.attack ?? 0);
    attack = Battle.statusPenaltyFor(this.data, mon, "attack", attack);
    const defense = Damage.applyStage(this.battleStat(mon, "defense"),
      stages.defense ?? 0);
    let damage = Damage.base(mon.level ?? 1, 40, attack, defense);
    damage = Math.min(damage, Damage.MAX_DAMAGE - Damage.MIN_DAMAGE)
      + Damage.MIN_DAMAGE;
    this.emit({ kind: "message",
      text: Strings.get("It hurt itself in its confusion!") });
    mon.hp = Math.max(0, (mon.hp ?? 0) - damage);
    // HitConfusion flickers with ANIM_HIT_CONFUSION on the self-hitter's own
    // turn, not the move after-anim (effect_commands.asm:624-632, :521-529).
    this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
      hp: mon.hp, anim: "ANIM_HIT_CONFUSION", animSide: this.sideOf(mon) });
    return damage;
  }

  // BattleCommand_CheckObedience (engine/battle/effect_commands.asm:642).
  // Player side only; an outsider mon (OT id differs from the player's) above
  // the badge-gated level cap rolls to obey.  Returns true when the mon
  // disobeyed and the turn is spent.
  //
  // The outcome ladder, in the asm's order: a first roll under the cap obeys;
  // a second roll under the cap uses a DIFFERENT move instead; past both, the
  // margin above the cap decides between napping, hitting itself and one of
  // the four loafing lines.
  // Lua: Battle.lua:4151
  checkObedience(moveId: any): boolean {
    const mon = this.player;
    if (!truthy(mon)) return false;
    // CheckUserIsCharging: the stored half of a two-turn move is exempt.
    if (truthy(this.volatile(mon).chargeMove)) return false;
    const save = this.save;
    const playerId = truthy(save) && truthy(save.player) ? save.player.id : undefined;
    if (mon.otId == null || playerId == null || mon.otId === playerId) {
      return false;
    }
    const cap = this.obedienceLevel();
    const level = mon.level ?? 1;
    if (level <= cap) return false;
    const limit = Math.min(255, cap + level);
    if (this.rollBelow(limit) < cap) return false;

    const name = this.monName(mon);
    if (this.rollBelow(limit) < cap) {
      // `.UseInstead`: another known move with PP, never the picked one and
      // never a disabled one; with no alternative it falls through to
      // loafing.
      const others: any[] = [];
      for (const move of (mon.moves ?? [])) {
        if (move.id !== moveId && (move.pp ?? 0) > 0
            && !this.moveDisabled(mon, move.id)) {
          others.push(move.id);
        }
      }
      if (others.length > 0) {
        const pick = others[rand(this.random, others.length)];
        this.useMove(mon, this.enemy, pick);
        return true;
      }
    }

    const margin = level - cap;
    const roll = rand(this.random, 256);
    if (roll < margin) {
      // `.Nap`: 1-7 turns of sleep written STRAIGHT into the status byte,
      // over whatever was there.
      mon.status = "sleep";
      mon.statusTurns = rand(this.random, 7) + 1;
      mon.toxicCounter = undefined;
      this.emit({ kind: "status", side: this.sideOf(mon), status: "sleep",
        text: Strings.get("%s began to nap!", name) });
      return true;
    }
    if (roll - margin < margin) {
      this.emit({ kind: "message", text: Strings.get("%s won't obey!", name) });
      this.confusionSelfHit(mon);
      return true;
    }
    // `.DoNothing`: one of four lines.
    const lines = [
      Strings.source("%s is loafing around."),
      Strings.source("%s won't obey!"), Strings.source("%s turned away!"),
      Strings.source("%s ignored orders!"),
    ];
    this.emit({ kind: "message",
      text: Strings.get(lines[rand(this.random, 4)]!, name) });
    return true;
  }

  // The battle half of the PACK's battle items, dispatched by the screen
  // (src/ui/gen2/BattleState.lua): the four X items raise one stage
  // (XItemEffect -> RaiseStat), and X ACCURACY / DIRE HIT / GUARD SPEC set
  // their SUBSTATUS bit, refusing a second use the way
  // WontHaveAnyEffect_NotUsedMessage does -- in that case the item is NOT
  // consumed and the turn not spent, which the false return tells the caller.
  // Returns [ok, reason] (the Lua's `true` / `false, reason`).
  // Lua: Battle.lua:4220
  useBattleItem(itemId: string): [boolean, string?] {
    const stat = Battle.X_ITEM_STATS[itemId];
    if (truthy(stat)) {
      const def = this.itemDef(itemId);
      this.emit({ kind: "message",
        text: Strings.get("Used the %s.", (truthy(def) && truthy(def.name)) ? def.name : itemId) });
      this.changeStage(this.player, stat, 1);
      return [true];
    }
    const field = Battle.SUBSTATUS_ITEMS[itemId];
    if (!truthy(field)) return [false, "unknown"];
    const state = this.volatile(this.player);
    if (truthy(state[field])) return [false, "no-effect"];
    state[field] = true;
    const def = this.itemDef(itemId);
    this.emit({ kind: "message",
      text: Strings.get("Used the %s.", (truthy(def) && truthy(def.name)) ? def.name : itemId) });
    if (itemId === "GUARD_SPEC") {
      this.emit({ kind: "message",
        text: Strings.get("%s's shrouded in MIST!", this.monName(this.player)) });
    } else if (itemId === "DIRE_HIT") {
      this.emit({ kind: "message",
        text: Strings.get("%s is getting pumped!", this.monName(this.player)) });
    }
    return [true];
  }

  // SpikesDamage (engine/battle/core.asm): an eighth of max HP the moment a mon
  // walks into them.  Gen 2 has one layer, but it does have the Flying
  // immunity (`cp FLYING / ret z` on BOTH type slots before GetEighthMaxHP), so
  // a Flying-type takes nothing and the line is not printed either.
  // Lua: Battle.lua:4252
  spikesDamage(mon: any): void {
    const side = this.sideOf(mon);
    if (!truthy(this.spikes[side]) || (mon.hp ?? 0) <= 0) return;
    const def = this.speciesDef(mon);
    for (const monType of ((truthy(def) && truthy(def.types)) ? def.types : (mon.types ?? []))) {
      if (monType === "FLYING") return;
    }
    const maxHp = mon.maxHp ?? ((truthy(mon.stats) ? mon.stats.hp : undefined) ?? 8);
    const damage = Math.max(1, Math.floor(maxHp / 8));
    mon.hp = Math.max(0, mon.hp - damage);
    this.emit({ kind: "message",
      text: Strings.get("%s is hurt by SPIKES!", this.monName(mon)) });
    // SpikesDamage is text, HP and a HUD redraw: no anim (core.asm:3902-3910).
    this.emit({ kind: "damage", side, amount: damage, hp: mon.hp,
      anim: false });
  }

  // CheckPlayerLockedIn (engine/battle/core.asm:533-556) quits ParsePlayerAction
  // outright for SUBSTATUS_ROLLOUT and SUBSTATUS_RAMPAGE, so a mon partway
  // through a Rollout or a Thrash is offered no menu, spends no PP and makes no
  // obedience check.  Split out because playerAttack needs the same answer.
  // Lua: Battle.lua:4274
  lockedInMove(mon: any): any {
    const state = this.volatile(mon);
    // engine/battle/core.asm:543
    if (truthy(state.chargeMove)) return state.chargeMove;
    if (truthy(state.rolloutLock)) return state.rolloutLock;
    if (truthy(state.rampageMove) && (state.rampageTurns ?? 0) > 0) {
      return state.rampageMove;
    }
    return undefined;
  }

  // ParsePlayerAction's bide arm (engine/battle/core.asm:569-576), enemy twin
  // at :5650
  // Lua: Battle.lua:4287
  fightLockedMove(mon: any): any {
    const state = this.volatile(mon);
    if (truthy(state.bideTurns)) return state.bideMove;
    return undefined;
  }

  // engine/battle/core.asm:627-629
  // Lua: Battle.lua:4294
  cancelBide(mon: any): void {
    clearBide(this.volatile(mon));
  }

  // Lua: Battle.lua:4312 (encoredMove, Lua:4301, is module-level after the class)
  forcedMove(mon: any): any {
    const locked = this.lockedInMove(mon);
    if (truthy(locked)) return locked;
    // ParsePlayerAction reads SUBSTATUS_ENCORED ahead of the bide arm
    // (engine/battle/core.asm:561-566).
    const encored = encoredMove(this.volatile(mon), mon);
    if (truthy(encored)) return encored;
    return this.fightLockedMove(mon);
  }

  // Lua: Battle.lua:4322
  moveDisabled(mon: any, moveId: any): boolean {
    return this.volatile(mon).disabled === moveId;
  }

  // The moves a side may actually pick this turn.
  // Lua: Battle.lua:4327
  usableMoves(mon: any): any[] {
    const forced = this.forcedMove(mon);
    // CheckPlayerLockedIn quits ParsePlayerAction ahead of
    // .CheckPlayerHasUsableMoves (core.asm:533-556), so a Rollout or a rampage
    // that spent its last PP on the opening turn keeps running.  Encore is not
    // in this exemption.  Bide is exempt too: .CheckPlayerHasUsableMoves lives
    // inside MoveSelectionScreen (core.asm:5058).
    const lockedA = this.lockedInMove(mon);
    const locked = truthy(lockedA) ? lockedA : this.fightLockedMove(mon);
    const out: any[] = [];
    for (const move of (mon.moves ?? [])) {
      let ok = (move.pp ?? 0) > 0 && !this.moveDisabled(mon, move.id);
      if (move.id === locked) ok = true;
      if (truthy(forced)) ok = ok && move.id === forced;
      if (ok) out.push(move);
    }
    return out;
  }

  // ../pokecrystal/engine/battle/core.asm:3687-3694 refuses TRAP, CELEBI,
  // FORCESHINY and SUICUNE; pokegold's :3476-3479 has only the first and third.
  // Lua: Battle.lua:4348
  noEscapeBattleType(): boolean {
    const t = this.battleType;
    return t === Battle.BATTLETYPE_FORCESHINY
      || t === Battle.BATTLETYPE_TRAP
      || t === Battle.BATTLETYPE_CELEBI
      || t === Battle.BATTLETYPE_SUICUNE;
  }

  // Running: Gen 2's odds (engine/battle/core.asm TryToRunAwayFromBattle) are
  // based on the speed ratio and how many times you have tried this battle.
  // Trainers never let you run.
  // Lua: Battle.lua:4359
  tryRun(pSpd?: number): boolean {
    // .cant_escape and .cant_run_from_trainer leave wBattlePlayerAction alone,
    // which is what BattleMenu_Run reads to decide whether the turn was spent
    // (engine/battle/core.asm:5035); only .cant_escape_2, the failed roll at the
    // bottom, writes BATTLEPLAYERACTION_USEITEM and buys the enemy a move.
    this.runRefused = undefined;
    // The battle-type ladder runs FIRST: BATTLETYPE_TRAP and
    // BATTLETYPE_FORCESHINY jump straight to .cant_escape, ahead of the
    // trainer check and any speed math.
    if (this.noEscapeBattleType()) {
      this.emit({ kind: "message", text: Strings.get("Can't escape!") });
      this.runRefused = true;
      return false;
    }
    if (truthy(this.trainer)) {
      this.emit({ kind: "message",
        text: Strings.get("No! There's no running from a trainer battle!") });
      this.runRefused = true;
      return false;
    }
    // SUBSTATUS_CANT_RUN held by the ENEMY (its Mean Look pinned the player)
    // and a live wrap count on the player both refuse before the speed math
    // and before the attempt is even counted.
    if (truthy(this.volatile(this.enemy).trapsTarget)
        || (this.volatile(this.player).wrapCount ?? 0) > 0) {
      this.emit({ kind: "message", text: Strings.get("Can't escape!") });
      this.runRefused = true;
      return false;
    }
    this.runAttempts = (this.runAttempts ?? 0) + 1;
    // engine/battle/core.asm:2614
    if (this.runRoll(truthy(pSpd) ? pSpd! : this.effectiveSpeed(this.player),
        this.effectiveSpeed(this.enemy))) {
      this.emit({ kind: "run", text: Strings.get("Got away safely!") });
      this.endBattle("run");
      return true;
    }
    this.emit({ kind: "message", text: Strings.get("Can't escape!") });
    return false;
  }

  // The escape roll itself, hooked as battle.run -- the same hook
  // BattleState:runRoll calls on Gen 1, with the same ctx keys (pSpd, eSpd,
  // attempts, rng) and the same boolean return.
  // Lua: Battle.lua:4406
  runRoll(pSpd: number, eSpd: number): boolean {
    if (Runtime.wantsHook("battle.run")) {
      return Runtime.call("battle.run", (c: any) => {
        return c.battle.runRollVanilla(c.pSpd, c.eSpd);
      }, { battle: this, pSpd, eSpd,
        attempts: this.runAttempts, rng: this.roller(),
        random: this.random });
    }
    return this.runRollVanilla(pSpd, eSpd);
  }

  // Lua: Battle.lua:4417
  runRollVanilla(pSpd: number, eSpd: number): boolean {
    if (pSpd >= eSpd) return true;
    // (playerSpeed * 32 / (enemySpeed / 4)) + 30 * attempts, out of 256.
    const odds = Math.floor(pSpd * 32
      / Math.max(1, Math.floor(eSpd / 4))) + 30 * (this.runAttempts ?? 1);
    return odds >= 256 || rand(this.random, 256) < odds;
  }

  // TryEnemyFlee (engine/battle/core.asm), called at the head of the enemy's
  // half of the turn in BOTH orders.
  //
  // The gates, in the asm's order:
  //   * trainer battles never flee (`ld a, [wBattleMode] / dec a / jr nz`)
  //   * SUBSTATUS_CANT_RUN on the PLAYER (Mean Look, Spider Web) pins it
  //   * a live wrap count pins it
  //   * frozen or asleep pins it
  //   * AlwaysFleeMons -> gone, no roll at all (Raikou, Entei and Suicune)
  //   * otherwise one random byte: under 50 percent + 1 lets OftenFleeMons go,
  //     and under 10 percent + 1 lets SometimesFleeMons go.  ONE byte for both
  //     gates, so the two lists are not independent rolls
  // Lua: Battle.lua:4447
  tryEnemyFlee(): boolean {
    if (!truthy(this.wild)) return false;
    // SUBSTATUS_CANT_RUN on the player's side and a live wrap count on the
    // enemy pin it BEFORE the status check.
    if (truthy(this.volatile(this.player).trapsTarget)) return false;
    if ((this.volatile(this.enemy).wrapCount ?? 0) > 0) return false;
    const status = this.enemy.status;
    if (status === "freeze" || status === "sleep") return false;
    const species = this.enemy.species;
    if (truthy(Roamers.ALWAYS_FLEE[species])) return this.enemyFled();
    const roll = rand(this.random, 256);
    if (roll >= Battle.OFTEN_FLEE_ROLL) return false;
    if (truthy(Roamers.OFTEN_FLEE[species])) return this.enemyFled();
    if (roll >= Battle.SOMETIMES_FLEE_ROLL) return false;
    if (truthy(Roamers.SOMETIMES_FLEE[species])) return this.enemyFled();
    return false;
  }

  // WildFled_EnemyFled_LinkBattleCanceled.  The result it writes is DRAW, the
  // same value the player's own successful run writes, which is what makes
  // BattleEnd_HandleRoamMons bank the beast's HP instead of clearing its slot.
  // The port's outcome name is "fled" so a caller can tell the two apart.
  // Lua: Battle.lua:4472
  enemyFled(): boolean {
    this.endBattle("fled");
    this.emit({ kind: "run", side: "enemy",
      text: Strings.get("Wild %s fled!", this.monName(this.enemy)) });
    return true;
  }

  // engine/battle/ai/items.asm AI_SwitchOrTryItem.  Wild mons never do either;
  // a trainer's class decides how eager it is.  Returns true when the turn was
  // spent on the switch or the item.
  // Lua: Battle.lua:4486
  enemyTrySwitchOrItem(): boolean {
    if (!Runtime.wantsHook("battle.enemy_switch_or_item")) {
      return Battle.vanillaEnemySwitchOrItem(this);
    }
    const chosen: any = Runtime.call("battle.enemy_switch_or_item", (battle: any) => {
      return Battle.vanillaEnemySwitchOrItem(battle);
    }, this);
    if (chosen !== null && typeof chosen === "object") {
      if (chosen.kind === "switch") {
        return this.switchEnemy(tonumber(chosen.index) ?? 0);
      }
      if (chosen.kind === "item") {
        return this.enemyUseItem(chosen.item);
      }
      return false;
    }
    return truthy(chosen);
  }

  // Lua: Battle.lua:4505
  static vanillaEnemySwitchOrItem(self: any): boolean {
    if (truthy(self.wild) || !truthy(self.trainer)) return false;
    const attributes = self.trainer.attributes;
    if (attributes === null || typeof attributes !== "object") return false;

    // The AI cannot rotate out of a trap either: a live wrap count on its
    // active mon or the player's CANT_RUN pin close the switch branch the way
    // they close TryPlayerSwitch, leaving only the item check.
    const trapped = (self.volatile(self.enemy).wrapCount ?? 0) > 0
      || self.volatile(self.player).trapsTarget === true;

    // CheckAbleToSwitch, then the class's own probability.
    const bench: any[] = [];
    const playerTypes = self.battleTypes(self.player);
    const matchups = self.data.type_chart && self.data.type_chart.matchups;
    for (let i = 0; i < self.enemyParty.length; i++) {
      const index = i + 1;
      const mon = self.enemyParty[i];
      if (index !== self.enemyIndex && (mon.hp ?? 0) > 0) {
        const def = self.speciesDef(mon);
        const types = (truthy(def) && truthy(def.types)) ? def.types : (mon.types ?? []);
        // "Resists" is the player's own type against the bench mon, which is
        // what FindEnemyMonsThatResistPlayer measures.
        const incoming = Damage.typeMultiplier(playerTypes[0], types, matchups);
        let super_ = false;
        for (const move of (mon.moves ?? [])) {
          const moveDef = self.moveDef(move.id);
          if (truthy(moveDef) && (moveDef.power ?? 0) > 0) {
            const mult = Damage.typeMultiplier(moveDef.type, playerTypes, matchups);
            if ((mult ?? 10) > 10) super_ = true;
          }
        }
        bench.push({ index, mon, healthy: true,
          resists: (incoming ?? 10) < 10, superEffective: super_ });
      }
    }

    // CheckPlayerMoveTypeMatchups: below BASE_AI_SWITCH_SCORE means the player's
    // moves are beating what is out.  Battle:playerMatchupScore owns that loop so
    // this layer and AI_Smart's four readers of it cannot disagree.
    // Ai.switchScore's two Lua values come back as [score, target].
    const [score, target] = Ai.switchScore({
      bench,
      perishCount: self.volatile(self.enemy).perish,
      matchupScore: self.playerMatchupScore(),
    });
    if (!trapped && truthy(target)
        && truthy(Ai.shouldSwitch(attributes, score, self.random))) {
      return self.switchEnemy(target);
    }

    // AI_TryItem: only the trainer's highest-level mon is worth an item.
    let highest = 0;
    for (const mon of self.enemyParty) {
      highest = Math.max(highest, mon.level ?? 0);
    }
    const item = Ai.chooseItem({
      items: self.trainer.items,
      isHighestLevel: (self.enemy.level ?? 0) >= highest,
      hp: self.enemy.hp,
      maxHp: self.enemy.maxHp ?? (self.enemy.stats ?? {}).hp,
      status: self.enemy.status,
      enemyTurns: self.volatile(self.enemy).turnsTaken ?? 0,
    });
    return self.enemyUseItem(item);
  }

  // (engine/battle/ai/items.asm:685), so a rotation announces the mon coming
  // Lua: Battle.lua:4572
  switchEnemy(index: number): boolean {
    const mon = truthy(this.enemyParty) ? this.enemyParty[index - 1] : undefined;
    if (!truthy(mon) || (mon.hp ?? 0) <= 0 || mon === this.enemy) return false;
    this.clearVolatile(this.enemy);
    const outgoing = this.enemy;
    const trainerName = (truthy(this.trainer) && truthy(this.trainer.name)) ? this.trainer.name : "TRAINER";
    this.emit({ kind: "message", text: Strings.get("%s withdrew %s!",
      trainerName, this.monName(outgoing)) });
    this.enemyIndex = index;
    this.enemy = mon;
    // AI_Switch (engine/battle/ai/items.asm:697)
    this.resetParticipants();
    // ResetEnemyBattleVars (engine/battle/core.asm:3016) zeroes wCurEnemyMove
    this.clearVolatile(this.enemy);
    this.stages.enemy = Battle.newStages();
    this.emit({ kind: "send", side: "enemy", mon: this.enemy,
      hp: this.enemy.hp ?? 0, status: this.enemy.status ?? false,
      level: this.enemy.level, experience: this.enemy.experience,
      text: Battle.sentOutText(trainerName, this.monName(this.enemy)) });
    Runtime.emit("battle.battler_switched", {
      battle: this, side: this.sideRecord(this.enemy), battler: this.enemy,
      previous: outgoing,
    });
    this.breakTrapsOnSend(this.enemy);
    this.spikesDamage(this.enemy);
    return true;
  }

  // Lua: Battle.lua:4600
  enemyUseItem(item: any): boolean {
    if (!truthy(item)) return false;
    // Consume it, so a trainer with one Potion cannot drink it every turn.
    const items: any[] = (truthy(this.trainer) && truthy(this.trainer.items)) ? this.trainer.items : [];
    for (let i = 0; i < items.length; i++) {
      if (items[i] === item) { this.trainer.items.splice(i, 1); break; }
    }
    const heal = Ai.HEAL_ITEMS[item];
    if (truthy(heal)) {
      this.heal(this.enemy, heal === Infinity
        ? (this.enemy.maxHp ?? (this.enemy.stats ?? {}).hp ?? 1) : heal);
      if (item === "FULL_RESTORE") {
        this.enemy.status = undefined;
        this.volatile(this.enemy).confuseCount = undefined;
      }
    } else if (item === "FULL_HEAL") {
      this.enemy.status = undefined;
      this.volatile(this.enemy).confuseCount = undefined;
    }
    const itemDef = this.itemDef(item);
    const itemName = (truthy(itemDef) && truthy(itemDef.name)) ? itemDef.name : (truthy(item) ? item : "?");
    this.emit({ kind: "message", text: Strings.get("%s used %s!",
      (truthy(this.trainer) && truthy(this.trainer.name)) ? this.trainer.name : "TRAINER", itemName) });
    return true;
  }

  // battle.enemy_action, the same hook BattleState:enemyAction calls on Gen 1:
  // the whole choke point is wrapped, so a mod can rewrite any trainer's choice
  // without registering a brain.  A table with an `id` (or a `move`) is
  // unwrapped rather than refused.
  // Lua: Battle.lua:4631
  enemyMove(): any {
    if (Runtime.wantsHook("battle.enemy_action")) {
      const chosen: any = Runtime.call("battle.enemy_action", (battle: any) => {
        return Battle.prototype.vanillaEnemyMove.call(battle);
      }, this);
      if (chosen !== null && typeof chosen === "object") {
        return truthy(chosen.id) ? chosen.id : chosen.move;
      }
      return chosen;
    }
    // Called through the module rather than the metatable: the charge-lock test
    // drives this against a bare stub table, which is also how the lock is
    // proved to read nothing but the volatile.
    return Battle.prototype.vanillaEnemyMove.call(this);
  }

  // Lua: Battle.lua:4645
  vanillaEnemyMove(): any {
    // A mon halfway through a two-turn move does not get to choose again.
    //
    // On the cart the charge sets SUBSTATUS_CHARGED and `CheckEnemyTurn` reuses
    // wEnemySelectedMove; the AI is never consulted for the second turn.
    // Without that lock the AI picks freely, which skips the stored attack AND
    // leaves the mon semi-invulnerable for the rest of the battle (found by the
    // Gold route bot: BRUNO's HITMONLEE opening with DIG).
    const enemyState = this.volatile(this.enemy);
    const charged = enemyState.chargeMove;
    if (truthy(charged)) return charged;

    // engine/battle/core.asm:5524-5533: the encore arm runs ahead of
    // CheckEnemyLockedIn (:5650).
    const encored = encoredMove(enemyState, this.enemy);
    if (truthy(encored)) return encored;
    if (truthy(enemyState.bideTurns)) return enemyState.bideMove;

    // Encore and Disable narrow the pool before the AI ever scores it.
    const moves = this.usableMoves(this.enemy);
    if (moves.length === 0) {
      // `.not_linked`'s encore arm runs ahead of the disable scan
      // (engine/battle/core.asm:5524-5529).
      const forced = this.forcedMove(this.enemy);
      if (truthy(forced)) return forced;
      // `.disabled` walks off the end into `.struggle` (:5555-5560).
      return undefined;
    }
    const flags = Ai.flagsOf(truthy(this.trainer) ? this.trainer.attributes : undefined);
    if (flags === 0) {
      return moves[rand(this.random, moves.length)].id;
    }
    const chosen = Ai.choose({
      moves,
      moveDef: (id: any) => this.moveDef(id),
      attacker: {
        level: this.enemy.level,
        stats: this.enemy.stats,
        types: this.battleTypes(this.enemy),
      },
      defender: {
        hp: this.player.hp,
        stats: this.player.stats,
        status: this.player.status,
        // AI_Basic reads SUBSTATUS_CONFUSED for the confusion moves, not the
        // status byte.
        confused: this.volatile(this.player).confuseCount != null,
        types: this.battleTypes(this.player),
      },
      typeChart: this.data.type_chart,
      // The dataset itself, which is where Ai.layersFor reads the merged
      // `ai_classes` records from (data.gen2AiClasses).
      data: this.data,
      // Everything the SETUP / OPPORTUNIST / CAUTIOUS / SMART layers read.
      enemyHp: this.enemy.hp,
      enemyMaxHp: this.enemy.maxHp ?? (this.enemy.stats ?? {}).hp,
      enemyTurns: this.volatile(this.enemy).turnsTaken ?? 0,
      playerTurns: this.volatile(this.player).turnsTaken ?? 0,
      smart: this.smartAiState(),
      // wLastPlayerCounterMove's base power, which AI_Smart_Encore and
      // AI_Smart_MirrorCoat both take as their fifth argument.
      playerLastPower: (() => {
        const last = this.volatile(this.player).lastMove;
        const def = truthy(last) ? this.moveDef(last) : undefined;
        return (truthy(def) && truthy(def.power)) ? def.power : undefined;
      })(),
      attackerStages: this.stages.enemy,
      defenderStages: this.stages.player,
      flags,
      random: (n: number) => rand(this.random, n),
    });
    return truthy(chosen) ? chosen : moves[0].id;
  }

  // battle.turn_ended closes the round battle.turn_started opened, whichever of
  // runTurn's exits was taken -- a faint, a flee, a forced switch or the ordinary
  // residual sweep.  A round that never happened (a refused RUN, a battle that
  // was already over) opened nothing and so closes nothing.
  // Lua: Battle.lua:5048
  takeTurn(action?: any): any[] {
    return this.closeTurn(runTurn(this, action));
  }

  // Lua: Battle.lua:5052
  takeLinkTurn(playerAction: any, enemyAction?: any): any[] {
    return this.closeTurn(runTurn(this, playerAction,
      truthy(enemyAction) ? enemyAction : { kind: "skip" }));
  }

  // Lua: Battle.lua:5057
  closeTurn(events: any[]): any[] {
    if (truthy(this.turnOpen)) {
      this.turnOpen = undefined;
      if (Runtime.wants("battle.turn_ended")) {
        Runtime.emit("battle.turn_ended", { battle: this, turn: this.turn });
      }
    }
    return events;
  }

  // HandleWeather: the count ticks down every turn and the weather ends the turn
  // it reaches zero.  Sandstorm chips an eighth off everything that is not Rock,
  // Ground or Steel.
  // Lua: Battle.lua:5070
  tickWeather(): void {
    if (!truthy(this.weather)) return;
    this.weatherTurns = this.weatherTurns - 1;
    if (this.weatherTurns <= 0) {
      this.emit({ kind: "weather", weather: undefined,
        text: Strings.get((Effects.WEATHER_END_TEXT as any)[this.weather]) });
      this.weather = undefined;
      return;
    }
    this.emit({ kind: "message",
      text: Strings.get((Effects.WEATHER_TURN_TEXT as any)[this.weather]) });
    if (this.weather !== "sandstorm") return;
    for (const mon of [this.player, this.enemy]) {
      if (mon == null) break; // ipairs stops at the first nil
      if ((mon.hp ?? 0) > 0 && !truthy(this.volatile(mon).vanished)) {
        const types = this.battleTypes(mon);
        if (Effects.sandstormHits(types)) {
          const maxHp = mon.maxHp ?? ((truthy(mon.stats) ? mon.stats.hp : undefined) ?? 8);
          const damage = Effects.sandstormDamage(maxHp);
          mon.hp = Math.max(0, mon.hp - damage);
          this.emit({ kind: "message",
            text: Strings.get("%s is buffeted by the sandstorm!",
              this.monName(mon)) });
          // .SandstormDamage plays ANIM_IN_SANDSTORM between two SwitchTurnCore
          // calls, so it runs from the OTHER side (core.asm:1688-1693).
          this.emit({ kind: "damage", side: this.sideOf(mon),
            amount: damage, hp: mon.hp, anim: "ANIM_IN_SANDSTORM" });
        }
      }
    }
  }

  // BattleCommand_CheckFutureSight: the stored damage lands when the counter
  // reaches one, on whoever is standing on the target's side by then.
  // Lua: Battle.lua:5104
  tickFutureSight(mon: any): void {
    const state = this.volatile(mon);
    if (!truthy(state.futureSight)) return;
    state.futureSight = state.futureSight - 1;
    if (state.futureSight > 0) return;
    const target = (state.futureSightSide === "player" && truthy(this.player)) ? this.player : this.enemy;
    const damage = state.futureSightDamage ?? 1;
    state.futureSight = undefined;
    state.futureSightDamage = undefined;
    state.futureSightSide = undefined;
    if ((target.hp ?? 0) <= 0) return;
    this.emit({ kind: "message",
      text: Strings.get("%s took the FUTURE SIGHT attack!",
        this.monName(target)) });
    this.dealDamage(mon, target, damage, {});
  }

  // The perish count ticks at the end of every turn and the mon faints on zero.
  // Lua: Battle.lua:5121
  tickPerish(mon: any): void {
    const state = this.volatile(mon);
    if (!truthy(state.perish) || (mon.hp ?? 0) <= 0) return;
    state.perish = state.perish - 1;
    if (state.perish > 0) {
      this.emit({ kind: "message", text: Strings.get("%s's PERISH count is %d!",
        this.monName(mon), state.perish) });
      return;
    }
    state.perish = undefined;
    mon.hp = 0;
    // HandlePerishSong just zeroes both HP bytes (core.asm:1119-1135).
    this.emit({ kind: "damage", side: this.sideOf(mon), amount: 0, hp: 0,
      anim: false });
  }

  // ResidualDamage's Leech Seed and Curse arms (engine/battle/core.asm:1010
  // and 1054): an eighth of the seeded mon's max HP crosses to whoever stands
  // on the OTHER side by now, then a quarter for the curse.  Both run only
  // while the sufferer still stands, and both survive the trapper leaving --
  // the flags sit on the suffering mon itself.
  // Lua: Battle.lua:5142
  tickSeedAndCurse(mon: any): void {
    const state = this.volatile(mon);
    const maxHp = mon.maxHp ?? ((truthy(mon.stats) ? mon.stats.hp : undefined) ?? 8);
    if (truthy(state.leechSeed) && (mon.hp ?? 0) > 0) {
      const damage = Math.min(Math.max(1, Math.floor(maxHp / 8)), mon.hp);
      mon.hp = mon.hp - damage;
      this.emit({ kind: "message",
        text: Strings.get("LEECH SEED saps %s!", this.monName(mon)) });
      // ANIM_SAP plays between two SwitchTurnCore calls, from the seeder's side
      // (core.asm:1013-1021).
      this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
        hp: mon.hp, anim: "ANIM_SAP" });
      const other = (mon === this.player && truthy(this.enemy)) ? this.enemy : this.player;
      if ((other.hp ?? 0) > 0) this.heal(other, damage);
    }
    // HandleNightmare's arm, between the seed and the curse (core.asm
    // ResidualDamage): a quarter while the sufferer sleeps; waking ends it.
    if (truthy(state.nightmare) && (mon.hp ?? 0) > 0) {
      if (mon.status !== "sleep") {
        state.nightmare = undefined;
      } else {
        const damage = Math.max(1, Math.floor(maxHp / 4));
        mon.hp = Math.max(0, mon.hp - damage);
        this.emit({ kind: "message",
          text: Strings.get("%s has a NIGHTMARE!", this.monName(mon)) });
        this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
          hp: mon.hp, anim: "ANIM_IN_NIGHTMARE", animSide: this.sideOf(mon) });
      }
    }
    if (truthy(state.cursed) && (mon.hp ?? 0) > 0) {
      const damage = Math.max(1, Math.floor(maxHp / 4));
      mon.hp = Math.max(0, mon.hp - damage);
      this.emit({ kind: "message",
        text: Strings.get("%s's hurt by the CURSE!", this.monName(mon)) });
      // The curse arm borrows ANIM_IN_NIGHTMARE, on the sufferer's own turn
      // (core.asm:1057-1060).
      this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
        hp: mon.hp, anim: "ANIM_IN_NIGHTMARE", animSide: this.sideOf(mon) });
    }
  }

  // HandleWrap (engine/battle/core.asm:1153): the count on the trapped mon
  // decrements FIRST -- release at zero, else a sixteenth of max HP.  A
  // Substitute suspends the whole tick, count included.
  // Lua: Battle.lua:5172
  tickWrap(mon: any): void {
    const state = this.volatile(mon);
    if (!truthy(state.wrapCount) || (mon.hp ?? 0) <= 0) return;
    if ((state.substitute ?? 0) > 0) return;
    state.wrapCount = state.wrapCount - 1;
    const moveName = truthy(state.wrapMove) ? state.wrapMove : "the trap";
    if (state.wrapCount <= 0) {
      state.wrapCount = undefined;
      state.wrapMove = undefined;
      state.wrapMoveId = undefined;
      this.emit({ kind: "message",
        text: Strings.get("%s was released from %s!", this.monName(mon), moveName) });
      return;
    }
    const maxHp = mon.maxHp ?? ((truthy(mon.stats) ? mon.stats.hp : undefined) ?? 16);
    const damage = Math.max(1, Math.floor(maxHp / 16));
    mon.hp = Math.max(0, mon.hp - damage);
    this.emit({ kind: "message",
      text: Strings.get("%s's hurt by %s!", this.monName(mon), moveName) });
    // The trapping move's own anim, played from the trapper's side between two
    // SwitchTurnCore calls (core.asm:1198-1203).
    this.emit({ kind: "damage", side: this.sideOf(mon), amount: damage,
      hp: mon.hp, anim: false, animMove: state.wrapMoveId });
  }

  // Lua: Battle.lua:5205
  tickScreens(): void {
    for (const side of ["player", "enemy"]) {
      const screens = this.screens[side];
      for (const field of ["lightScreen", "reflect", "safeguard"]) {
        if ((screens[field] ?? 0) > 0) {
          screens[field] = screens[field] - 1;
          if (screens[field] <= 0) {
            screens[field] = undefined;
            if (field === "safeguard") {
              // engine/battle/core.asm:1527
              this.emit({ kind: "message",
                text: Strings.get("%s's SAFEGUARD faded!",
                  this.monName((this as any)[side])) });
            } else {
              this.emit({ kind: "message",
                text: Strings.get(Battle.SCREEN_FALL_TEXT[field]!,
                  Strings.get(Battle.SCREEN_SIDE_LABEL[side]!)) });
            }
          }
        }
      }
    }
  }

  // Encore, Disable and the two one-turn braces.  Protect and Endure last only
  // the turn they are used, which is why they are cleared here rather than by
  // whatever they blocked.
  // Lua: Battle.lua:5232
  tickCounters(mon: any): void {
    const state = this.volatile(mon);
    state.protect = undefined;
    state.endure = undefined;
    // A flinch lasts only the turn it was inflicted; a leftover one (the
    // target moved first, or fainted) must not eat next turn.
    state.flinched = undefined;
    if (truthy(state.encoreTurns)) {
      state.encoreTurns = state.encoreTurns - 1;
      if (state.encoreTurns <= 0) {
        state.encore = undefined;
        state.encoreTurns = undefined;
        this.emit({ kind: "message",
          text: Strings.get("%s's ENCORE ended!", this.monName(mon)) });
      }
    }
    if (truthy(state.disabledTurns)) {
      state.disabledTurns = state.disabledTurns - 1;
      if (state.disabledTurns <= 0) {
        state.disabled = undefined;
        state.disabledTurns = undefined;
        this.emit({ kind: "message",
          text: Strings.get("%s's move is no longer disabled!",
            this.monName(mon)) });
      }
    }
  }

  // Lua: Battle.lua:5277
  itemDef(itemId: any): any {
    const items = this.data.items;
    return (truthy(itemId) && truthy(items)) ? (items[itemId] ?? undefined) : undefined;
  }

  // The rest of the held effects act inside a hit rather than at the end of a
  // turn, so they are not this function's business.
  // Lua: Battle.lua:5282
  tickHeldItem(mon: any): void {
    if ((mon.hp ?? 0) <= 0) return;
    const def = this.itemDef(mon.item);
    if (!truthy(def)) return;
    // Through Battle:heldEffect rather than off the record, so the end-of-turn
    // arm is one more held_item.trigger site and not a hole in it.  `def` stays
    // the item's own record: the messages below name the ITEM the mon is
    // holding, which a substituted effect does not change.
    // heldEffect's two Lua values come back as [effect, parameter].
    const [effect, parameter] = this.heldEffect(mon, "residual");
    if (!truthy(effect)) return;
    const maxHp = mon.maxHp ?? ((truthy(mon.stats) ? mon.stats.hp : undefined) ?? 1);
    const name = this.monName(mon);

    if (effect === "HELD_LEFTOVERS") {
      if ((mon.hp ?? 0) >= maxHp) return;
      const healed = this.heal(mon, Math.max(1, Math.floor(maxHp / 16)));
      if (healed > 0) {
        this.emit({ kind: "message",
          text: Strings.get("%s's %s restored health!", name,
            def.name ?? "item") });
      }
      return;
    }

    if (effect === "HELD_BERRY" && (mon.hp ?? 0) * 2 <= maxHp) {
      // pokegold engine/battle/core.asm:4074 ItemRecoveryAnim
      this.heal(mon, parameter > 0 ? parameter : 10, { anim: "RECOVER" });
      mon.item = undefined;
      this.emit({ kind: "message",
        text: Strings.get("%s ate the %s!", name, def.name ?? "BERRY") });
      return;
    }

    let cure: any = Battle.HELD_STATUS_CURES[effect as string];
    if (effect === "HELD_HEAL_STATUS") cure = mon.status;
    if (truthy(cure) && mon.status === cure) {
      mon.status = undefined;
      mon.statusTurns = undefined;
      mon.toxicCounter = undefined;
      mon.item = undefined;
      this.emit({ kind: "status", side: this.sideOf(mon), status: undefined,
        text: Strings.get("%s's %s cured its status!", name,
          def.name ?? "item") });
    }

    // UseConfusionHealingItem: HELD_HEAL_CONFUSION (a Bitter Berry) and the
    // catch-all HELD_HEAL_STATUS also clear the confusion volatile, and are
    // consumed doing it.
    if ((effect === "HELD_HEAL_CONFUSION" || effect === "HELD_HEAL_STATUS")
        && truthy(this.volatile(mon).confuseCount)) {
      this.volatile(mon).confuseCount = undefined;
      mon.item = undefined;
      this.emit({ kind: "message",
        text: Strings.get("%s's %s cured its confusion!", name,
          def.name ?? "item") });
    }
  }

  // The link driver's replacement after a faint: `side` "enemy" sends in the
  // foe's pick (clears pendingEnemySwitch), anything else routes through
  // Battle:switch.  A bad pick falls back to the first healthy mon.
  // `index` is the 1-based party slot.
  // Lua: Battle.lua:5340
  forcedReplacement(side: string, index: any): boolean {
    index = tonumber(index);
    if (side === "enemy") {
      const party = truthy(this.enemyParty) ? this.enemyParty : [];
      let mon = index != null ? party[index - 1] : undefined;
      if (!truthy(mon) || (mon.hp ?? 0) <= 0 || truthy(mon.isEgg)) {
        index = Battle.firstHealthy(party);
        mon = truthy(index) ? party[index - 1] : undefined;
      }
      if (!truthy(mon)) return false;
      this.pendingEnemySwitch = undefined;
      const previous = this.enemy;
      this.clearVolatile(previous);
      this.enemyIndex = index;
      this.enemy = mon;
      this.clearVolatile(mon);
      this.stages.enemy = Battle.newStages();
      this.emit({ kind: "send", side: "enemy", mon, replacement: true,
        hp: mon.hp ?? 0, status: mon.status ?? false,
        level: mon.level, experience: mon.experience,
        text: Battle.sentOutText((truthy(this.trainer) && truthy(this.trainer.name)) ? this.trainer.name : "Foe",
          this.monName(mon)) });
      Runtime.emit("battle.battler_switched", {
        battle: this, side: this.sideRecord(mon), battler: mon,
        previous,
      });
      this.breakTrapsOnSend(mon);
      this.spikesDamage(mon);
      return true;
    }
    const mon = index != null ? this.party[index - 1] : undefined;
    if (!truthy(mon) || (mon.hp ?? 0) <= 0 || truthy(mon.isEgg)) {
      index = Battle.firstHealthy(this.party);
    }
    if (!truthy(index)) return false;
    return this.switch(index);
  }

  // Lua: Battle.lua:5465 (helpers linkOff..linkBench, Lua:5395-5463, are
  // module-level after the class).  Every list walked here is a fixed array
  // (LINK_STAGES / LINK_VOLATILE / LINK_SCREENS / the parties), so the
  // signature is deterministic with no pairs() order involved.
  linkSignature(role: string): { actives: string; volatile: string; bench: string } {
    const hostIsPlayer = role !== "guest";
    const hostKey = hostIsPlayer ? "player" : "enemy";
    const guestKey = hostIsPlayer ? "enemy" : "player";
    const hostMon = hostIsPlayer ? this.player : this.enemy;
    const guestMon = hostIsPlayer ? this.enemy : this.player;
    const hostParty = hostIsPlayer ? this.party : this.enemyParty;
    const guestParty = hostIsPlayer ? this.enemyParty : this.party;
    return {
      actives: linkActive(this, hostMon, hostKey) + "|"
        + linkActive(this, guestMon, guestKey)
        + "|r" + tostring(this.rngDraws ?? 0),
      volatile: linkVolatile(hostMon) + "|" + linkVolatile(guestMon)
        + "|" + linkSide(this, hostKey) + "|" + linkSide(this, guestKey)
        + "|w" + tostring(truthy(this.weather) ? this.weather : "-")
        + ":" + tostring(this.weatherTurns ?? 0),
      bench: linkBench(hostParty) + "|" + linkBench(guestParty),
    };
  }
}

// The GymLeaders -> KantoGymLeaders fallthrough (see GYM_LEADER_CLASSES).
// Lua: Battle.lua:124
for (const cls of sortedKeys(Battle.KANTO_GYM_LEADER_CLASSES)) {
  Battle.GYM_LEADER_CLASSES[cls] = true;
}

// Lua: Battle.lua:185
const BATTLETYPE_NAMES: Record<string, number> = {
  normal: Battle.BATTLETYPE_NORMAL,
  canlose: Battle.BATTLETYPE_CANLOSE,
  debug: Battle.BATTLETYPE_DEBUG,
  tutorial: Battle.BATTLETYPE_TUTORIAL,
  fish: Battle.BATTLETYPE_FISH,
  roaming: Battle.BATTLETYPE_ROAMING,
  contest: Battle.BATTLETYPE_CONTEST,
  forceshiny: Battle.BATTLETYPE_FORCESHINY,
  tree: Battle.BATTLETYPE_TREE,
  trap: Battle.BATTLETYPE_TRAP,
  forceitem: Battle.BATTLETYPE_FORCEITEM,
  celebi: Battle.BATTLETYPE_CELEBI,
  suicune: Battle.BATTLETYPE_SUICUNE,
};

// ------------------------------------------------------------------------
// Battle.lua PART B, module level: the MOVE_EFFECTS handlers, the effect-record
// fold and the status records (Battle.lua:2121-3513).
// ------------------------------------------------------------------------

/**
 * A MOVE_EFFECTS handler: the Gold signature fn(battle, attacker, defender,
 * def, moveId, sureHit) useMove dispatches on (Battle.lua:3033).
 */
export type MoveEffectRun = (self: Battle, attacker?: any, defender?: any,
  def?: any, moveId?: any, sureHit?: any) => void;

/**
 * One `statuses` record (Battle.lua:3126-3160).  beforeMove is
 * fn(battle, mon, name) -> canAct; residual is fn(battle, mon, maxHp) ->
 * [damage, text] (the Lua's two return values); onInflict is fn(battle, mon).
 */
export interface StatusRecord {
  id: string;
  label: string;
  healClass?: string;
  inflictText?: string;
  catchBonus?: number;
  catchBonusIntended?: number;
  statPenalty?: { stat: string; div?: number };
  beforeMovePriority?: number;
  beforeMove?: (battle: any, mon: any, name: string) => boolean;
  residual?: (battle: any, mon: any, maxHp: number) => [number, string] | undefined;
  onInflict?: (battle: any, mon: any) => void;
  substatus?: boolean;
  [k: string]: any;
}

// Every effect command's own `.failed` tail reaches AnimateFailedMove
// (effect_commands.asm:6656): a delay and no animation, so a failed move is
// marked the same way a missed one is.
// Lua: Battle.lua:2126
function fail(self: Battle): void {
  self.markMissed();
  self.emit({ kind: "message", text: Strings.get("But it failed!") });
}

// BattleCommand_Splash (engine/battle/move_effects/splash.asm): the whole
// command is the animation and then `jp PrintNothingHappened`, and the effect
// list (data/moves/effects.asm:1156) has no checkhit at all, so the move never
// rolls accuracy and never touches the target.
// Lua: Battle.lua:2137
Battle.MOVE_EFFECTS.EFFECT_SPLASH = function (self: Battle) {
  // NothingHappenedText (data/text/battle.asm:870): "But nothing" / "happened."
  self.emit({ kind: "message",
    text: Strings.get("But nothing\nhappened.") });
};

// BattleCommand_StartRain / StartSun / StartSandstorm.  Sandstorm is the only
// one that refuses to re-cast itself.  (pairs order: each key is written once,
// so the order only decides MOVE_EFFECTS' key order.)
// Lua: Battle.lua:2145
for (const [effect, weather] of Object.entries(Effects.WEATHER as Record<string, string>)) {
  Battle.MOVE_EFFECTS[effect] = function (self: Battle, _attacker?: any) {
    if (weather === "sandstorm" && self.weather === "sandstorm") {
      return fail(self);
    }
    self.weather = weather;
    self.weatherTurns = Effects.WEATHER_TURNS;
    self.emit({ kind: "weather", weather,
      text: Strings.get(Effects.WEATHER_START_TEXT[weather]) });
  };
}

// BattleCommand_PerishSong: four turns on BOTH sides, and it fails only when
// both are already counting.
// Lua: Battle.lua:2159
Battle.MOVE_EFFECTS.EFFECT_PERISH_SONG = function (self: Battle) {
  const mine = self.volatile(self.player);
  const theirs = self.volatile(self.enemy);
  if (truthy(mine.perish) && truthy(theirs.perish)) return fail(self);
  if (!truthy(mine.perish)) mine.perish = Effects.PERISH_TURNS;
  if (!truthy(theirs.perish)) theirs.perish = Effects.PERISH_TURNS;
  // StartPerishText (data/text/battle.asm:986): the Gen 2 line names both
  // sides and counts in digits.
  self.emit({ kind: "message",
    text: Strings.get("Both POKéMON will\nfaint in 3 turns!") });
};

// BattleCommand_Encore: 3-6 turns locked into the move the target last used.
// Lua: Battle.lua:2173
Battle.MOVE_EFFECTS.EFFECT_ENCORE = function (self: Battle, _attacker: any, defender: any) {
  const target = self.volatile(defender);
  const last = target.lastMove;
  if (!truthy(last) || truthy(Effects.ENCORE_BLOCKED[last]) || truthy(target.encore)) {
    return fail(self);
  }
  // The move has to still be in the target's list with PP left.
  let found: any;
  for (const move of defender.moves ?? []) {
    if (move.id === last && (move.pp ?? 0) > 0) found = move;
  }
  if (!truthy(found)) return fail(self);
  target.encore = last;
  target.encoreTurns = Effects.encoreTurns(self.random);
  self.emit({ kind: "message",
    text: Strings.get("%s got an ENCORE!", self.monName(defender)) });
};

// BattleCommand_Disable: one of the target's moves, for 2-9 turns.  It fails
// when something is already disabled, or when the target has not moved.
// Lua: Battle.lua:2193
Battle.MOVE_EFFECTS.EFFECT_DISABLE = function (self: Battle, _attacker: any, defender: any) {
  const target = self.volatile(defender);
  if (truthy(target.disabled)) return fail(self);
  const last = target.lastMove;
  if (!truthy(last) || last === "STRUGGLE") return fail(self);
  let found: any;
  for (const move of defender.moves ?? []) {
    if (move.id === last && (move.pp ?? 0) > 0) found = move;
  }
  if (!truthy(found)) return fail(self);
  target.disabled = last;
  target.disabledTurns = Effects.disableTurns(self.random);
  const moveDef = self.moveDef(last);
  const moveName = (truthy(moveDef) ? moveDef.name : undefined) ?? last ?? "?";
  self.emit({ kind: "message",
    text: Strings.get("%s's %s was disabled!", self.monName(defender),
      moveName) });
};

// BattleCommand_LockOn: Lock-On and Mind Reader set SUBSTATUS_LOCK_ON on the
// TARGET, not on the user, which is why the AI reads wPlayerSubStatus5 to ask
// whether its own lock-on has landed.  A Substitute blocks it outright.
// Lua: Battle.lua:2215
Battle.MOVE_EFFECTS.EFFECT_LOCK_ON = function (self: Battle, attacker: any, defender: any) {
  const target = self.volatile(defender);
  if ((target.substitute ?? 0) > 0) {
    // lock_on.asm's `.fail`: AnimateFailedMove, then PrintDidntAffect.  The
    // animation is AnimateCurrentMove on the success arm only.
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("It doesn't affect %s...", self.monName(defender)) });
    return;
  }
  target.lockOn = true;
  self.emit({ kind: "message",
    text: Strings.get("%s took aim!", self.monName(attacker)) });
};

// engine/battle/move_effects/foresight.asm
// Lua: Battle.lua:2231
Battle.MOVE_EFFECTS.EFFECT_FORESIGHT = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!truthy(sureHit)
      && !truthy(self.accuracyRoll(def, attacker, defender))) {
    return fail(self);
  }
  const target = self.volatile(defender);
  if (truthy(target.vanished) || truthy(target.identified)) return fail(self);
  target.identified = true;
  self.emit({ kind: "message",
    text: Strings.get("%s identified %s!", self.monName(attacker),
      self.monName(defender)) });
};

// BattleCommand_Spikes: laid on the side that will switch into them, and it
// refuses a second layer (Gen 2 has only one).
// Lua: Battle.lua:2319
Battle.MOVE_EFFECTS.EFFECT_SPIKES = function (self: Battle, _attacker: any, defender: any) {
  const side = self.sideOf(defender);
  if (truthy(self.spikes[side])) return fail(self);
  self.spikes[side] = true;
  // SpikesText (data/text/battle.asm:974) is three rows, the third scrolled
  // (`cont`) and carrying <TARGET>.  The battle message path has no `cont`,
  // so the cart's line cannot be told here yet without the name being
  // dropped on screen.  Left as it stands.
  self.emit({ kind: "message",
    text: Strings.get("Spikes were scattered all around!") });
};

// BattleCommand_Protect / Endure share ProtectChance, which halves the odds
// for every consecutive use and zeroes the counter the moment one fails.
// Lua: Battle.lua:2334
function protectLike(field: string, text: string): MoveEffectRun {
  return function (self: Battle, attacker: any) {
    const state = self.volatile(attacker);
    // move_effects/protect.asm:22-23: `call CheckOpponentWentFirst / jr nz,
    // .failed`, ahead of everything else ProtectChance rolls.
    // move_effects/protect.asm:27-30: no Protect from behind a Substitute.
    if ((truthy(self.firstMover) && self.firstMover !== self.sideOf(attacker))
        || (state.substitute ?? 0) > 0
        || !truthy(Effects.protectSucceeds(state.protectCount ?? 0, self.roller()))) {
      state.protectCount = 0;
      return fail(self);
    }
    state.protectCount = (state.protectCount ?? 0) + 1;
    state[field] = true;
    self.emit({ kind: "message",
      text: Strings.get(text, self.monName(attacker)) });
  };
}

// Lua: Battle.lua:2354
Battle.MOVE_EFFECTS.EFFECT_PROTECT = protectLike("protect",
  Strings.source("%s protected itself!"));
Battle.MOVE_EFFECTS.EFFECT_ENDURE = protectLike("endure",
  Strings.source("%s braced itself!"));

// BattleCommand_UnleashEnergy / StoreEnergy.  Turn one starts the store; the
// turn the counter runs out the user hits for double everything it took.
// Lua: Battle.lua:2361
Battle.MOVE_EFFECTS.EFFECT_BIDE = function (self: Battle, attacker: any, defender: any,
    def: any, moveId: any) {
  const state = self.volatile(attacker);
  if (!truthy(state.bideTurns)) {
    state.bideTurns = Effects.bideTurns(self.random);
    state.bideStored = 0;
    // engine/battle/core.asm:574-576
    state.bideMove = moveId;
    self.emit({ kind: "message",
      text: Strings.get("%s is storing energy!", self.monName(attacker)) });
    return;
  }
  state.bideTurns = state.bideTurns - 1;
  if (state.bideTurns > 0) {
    self.emit({ kind: "message",
      text: Strings.get("%s is storing energy!", self.monName(attacker)) });
    return;
  }
  const damage = Effects.bideDamage(state.bideStored);
  delete state.bideTurns;
  delete state.bideStored;
  delete state.bideMove;
  self.emit({ kind: "message",
    text: Strings.get("%s unleashed energy!", self.monName(attacker)) });
  if (damage <= 0) return fail(self);
  self.dealDamage(attacker, defender, damage, { move: def, moveId });
};

// BattleCommand_Transform: the user takes the target's species, types, moves
// and stats, keeping its own HP and level.  Every copied move gets 5 PP.
// Lua: Battle.lua:2388
Battle.MOVE_EFFECTS.EFFECT_TRANSFORM = function (self: Battle, attacker: any, defender: any) {
  const state = self.volatile(attacker);
  // engine/battle/move_effects/transform.asm:7
  if (truthy(state.transformed) || truthy(self.volatile(defender).substitute)
      || truthy(self.volatile(defender).vanished)) {
    return fail(self);
  }
  state.transformed = true;
  // a mimicked move is put back before the moves are saved, so the copy the
  // Transform keeps to restore is the mon's own; the target's types replace
  // any CONVERSION
  if (truthy(state.preMimic)) {
    attacker.moves = state.preMimic;
    delete state.preMimic;
  }
  state.typeOverride = undefined;
  const attackerName = self.monName(attacker);
  // The cart copies the target into BATTLE ram (wBattleMon / wEnemyMon) and
  // leaves the struct the mon was loaded FROM alone, so every route out of the
  // battle hands back a DITTO.  This port has one table per mon, so the
  // identity the copy is about to overwrite is kept here and put back by
  // Battle:untransform, which every one of those routes goes through.
  state.preTransform = {
    species: attacker.species,
    types: attacker.types,
    moves: attacker.moves,
    shiny: attacker.shiny,
    stats: {} as Record<string, any>,
  };
  const targetDef = self.speciesDef(defender);
  attacker.species = defender.species;
  attacker.types = (truthy(targetDef) ? targetDef.types : undefined) ?? defender.types;
  attacker.shiny = defender.shiny;
  const moves: any[] = [];
  for (const move of defender.moves ?? []) {
    moves.push({ id: move.id, pp: 5, maxPp: 5 });
  }
  attacker.moves = moves;
  // Everything but HP is copied, which is why a Transformed Ditto has the
  // target's Attack and its own hit points.
  const stats = attacker.stats ?? {};
  const theirs = defender.stats ?? {};
  for (const key of ["attack", "defense", "speed", "specialAttack",
      "specialDefense"]) {
    // (a nil write leaves the Lua table without the key)
    if (stats[key] != null) state.preTransform.stats[key] = stats[key];
    const value = theirs[key] ?? stats[key];
    if (value != null) stats[key] = value;
  }
  attacker.stats = stats;
  const targetName = (truthy(targetDef) ? targetDef.name : undefined)
    ?? defender.species ?? self.monName(defender) ?? "?";
  self.emit({ kind: "message", text: Strings.get("%s TRANSFORMED into %s!",
    attackerName, targetName) });
  // The moment itself, for the screen.  src/ui/gen2/BattleState.lua draws each
  // side's pic and HUD from `shownMon`, which follows the EVENT QUEUE rather
  // than the battle, so a transform is the third identity swap (after
  // `shownHp` and the `send` event) and this is its event.  `mon` is the
  // battler whose pic changes and `from` is what it was.
  // ../pokecrystal/engine/battle/move_effects/transform.asm:118-136
  self.emit({ kind: "transform", side: self.sideOf(attacker),
    mon: attacker, species: attacker.species,
    from: state.preTransform.species });
};

// BattleCommand_FutureSight: four turns, damage rolled and stored now.
// Lua: Battle.lua:2485
Battle.MOVE_EFFECTS.EFFECT_FUTURE_SIGHT = function (self: Battle, attacker: any, defender: any,
    def: any) {
  const state = self.volatile(attacker);
  if (truthy(state.futureSight)) return fail(self);
  const [damage] = Damage.calc({
    level: attacker.level ?? 1,
    power: def.power,
    moveType: def.type,
    attacker: {
      attack: (attacker.stats ?? {}).attack,
      specialAttack: (attacker.stats ?? {}).specialAttack,
      types: self.battleTypes(attacker),
      stages: self.stages[self.sideOf(attacker)],
    },
    defender: {
      defense: (defender.stats ?? {}).defense,
      specialDefense: (defender.stats ?? {}).specialDefense,
      types: self.battleTypes(defender),
      stages: self.stages[self.sideOf(defender)],
    },
    types: truthy(self.data.type_chart) ? self.data.type_chart.types : undefined,
    matchups: self.matchupsAgainst(defender),
    random: self.random,
  });
  state.futureSight = Effects.FUTURE_SIGHT_TURNS;
  state.futureSightDamage = Math.max(1, damage);
  state.futureSightSide = self.sideOf(defender);
  self.emit({ kind: "message",
    text: Strings.get("%s foresaw an attack!", self.monName(attacker)) });
};

// BattleCommand_OHKO: fails outright against a higher-level target, and the
// level difference is worth two accuracy points each.
// Lua: Battle.lua:2517
Battle.MOVE_EFFECTS.EFFECT_OHKO = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, locked?: any) {
  const accuracy = Effects.ohkoAccuracy(def.accuracy, attacker.level,
    defender.level);
  if (!truthy(accuracy)) {
    // `.no_effect` sets wAttackMissed (effect_commands.asm:5414-5419) and
    // `ohko` sits ahead of `moveanim` in OHKOHit (data/moves/effects.asm:917),
    // so the level refusal plays MoveDelay and nothing else.
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("It doesn't affect %s...", self.monName(defender)) });
    return;
  }
  // BattleCommand_OHKO ends on `call BattleCommand_CheckHit`, so a lock-on
  // carries Fissure past the level-scaled roll -- and so does
  // SUBSTATUS_X_ACCURACY, which is why an X ACCURACY makes the OHKO moves
  // sure hits in Gen 2 (`locked` here is useMove's sureHit).
  const hit = truthy(locked) || truthy(self.accuracyRoll(def, attacker, defender, accuracy));
  if (!hit) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("%s's attack missed!", self.monName(attacker)) });
    return;
  }
  self.dealDamage(attacker, defender, defender.hp ?? 1,
    { move: def, moveId: truthy(def) ? def.id : undefined });
  self.emit({ kind: "message", text: Strings.get("It's a one-hit KO!") });
};

// BattleCommand_BeatUp: one hit per healthy, unstatused party member, each
// swinging with its own base Attack.
// Lua: Battle.lua:2548
Battle.MOVE_EFFECTS.EFFECT_BEAT_UP = function (self: Battle, attacker: any, defender: any,
    def: any) {
  const party = attacker === self.player ? self.party : self.enemyParty;
  const active = attacker === self.player ? self.playerIndex : self.enemyIndex;
  const hits = Effects.beatUpParty(party, active);
  if (hits.length === 0) return fail(self);
  const targetDef = self.speciesDef(defender);
  let landed = 0;
  for (const entry of hits) {
    if ((defender.hp ?? 0) <= 0) break;
    const monDef = truthy(self.data.pokemon) ? self.data.pokemon[entry.mon.species] : undefined;
    const base = (truthy(monDef) ? monDef.baseStats : undefined) ?? {};
    const [damage] = Damage.calc({
      level: entry.mon.level ?? attacker.level ?? 1,
      power: def.power,
      moveType: def.type,
      // The BASE stats, not the battle stats: Beat Up asks GetBaseData for
      // each party member and the target both.
      attacker: { attack: base.attack ?? 1, specialAttack: base.attack ?? 1,
        types: [], stages: {} },
      defender: {
        defense: targetDef?.baseStats?.defense ?? 1,
        specialDefense: targetDef?.baseStats?.defense ?? 1,
        types: [], stages: {},
      },
      types: truthy(self.data.type_chart) ? self.data.type_chart.types : undefined,
      matchups: truthy(self.data.type_chart) ? self.data.type_chart.matchups : undefined,
      random: self.random,
    });
    self.emit({ kind: "message",
      text: Strings.get("%s's attack!", self.monName(entry.mon)) });
    self.dealDamage(attacker, defender, Math.max(1, damage),
      { move: def, moveId: truthy(def) ? def.id : undefined });
    landed = landed + 1;
  }
  // BattleCommand_EndLoop prints the same line for Beat Up, and Beat Up can
  // land exactly once, which is the case the cart still prints as "times".
  self.emit({ kind: "message", text: Strings.get("Hit %d times!", landed) });
};

// BattleCommand_Heal (effect_commands.asm:5986): Recover and Rest are both
// EFFECT_HEAL and split on the MOVE (:6007), Rest taking GetMaxHP (:6043).
// Lua: Battle.lua:2591
Battle.MOVE_EFFECTS.EFFECT_HEAL = function (self: Battle, attacker: any, _defender?: any,
    _def?: any, moveId?: any) {
  const maxHp = attacker.maxHp ?? attacker.stats?.hp ?? 1;
  // effect_commands.asm:6061: full HP answers HPIsFullText, not the fail line.
  if ((attacker.hp ?? 0) >= maxHp) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("%s's HP is full!", self.monName(attacker)) });
    return;
  }
  if (moveId === "REST") {
    // effect_commands.asm:6015-6027: the toxic bit clears, the status byte
    // becomes REST_SLEEP_TURNS + 1, and the line depends on the old status.
    const cured = attacker.status != null;
    attacker.status = "sleep";
    attacker.statusTurns = 3;
    delete attacker.toxicCounter;
    const source = cured
      ? Strings.source("%s fell asleep and became healthy!")
      : Strings.source("%s went to sleep!");
    self.emit({ kind: "status", side: self.sideOf(attacker),
      status: "sleep", text: Strings.get(source, self.monName(attacker)) });
    self.heal(attacker, maxHp);
  } else {
    self.heal(attacker, Math.max(1, Math.floor(maxHp / 2)));
  }
  // effect_commands.asm:6058, RegainedHealthText.
  self.emit({ kind: "message",
    text: Strings.get("%s regained health!", self.monName(attacker)) });
};

// BattleCommand_TimeBasedHealContinue (effect_commands.asm:6374) answers the
// same two lines BattleCommand_Heal does: HPIsFullText (:6447) and
// RegainedHealthText (:6440).  (pairs order: each key written once.)
// Lua: Battle.lua:2624
for (const [effect, wants] of Object.entries(Effects.SUN_HEAL as Record<string, number>)) {
  Battle.MOVE_EFFECTS[effect] = function (self: Battle, attacker: any) {
    const maxHp = attacker.maxHp ?? attacker.stats?.hp ?? 1;
    if ((attacker.hp ?? 0) >= maxHp) {
      self.markMissed();
      self.emit({ kind: "message",
        text: Strings.get("%s's HP is full!", self.monName(attacker)) });
      return;
    }
    // effect_commands.asm:6396-6417, the time of day and the weather (#1751).
    const fraction = Effects.timeBasedHealFraction(self.weather, wants,
      self.timeOfDay);
    self.heal(attacker, Math.max(1, Math.floor(maxHp * fraction)));
    self.emit({ kind: "message",
      text: Strings.get("%s regained health!", self.monName(attacker)) });
  };
}

// BattleCommand_BatonPass: the switch keeps everything ResetBatonPassStatus
// does NOT clear -- the stat stages above all, which is the point of the move.
// Party indices stay the Lua's 1-based values (playerIndex, participants
// keys, the event's `index`); only the array reads subtract one.
// Lua: Battle.lua:2644
Battle.MOVE_EFFECTS.EFFECT_BATON_PASS = function (self: Battle, attacker: any) {
  const side = self.sideOf(attacker);
  const party: any[] = side === "player" ? self.party : self.enemyParty;
  const current = side === "player" ? self.playerIndex : self.enemyIndex;
  let target: number | undefined;
  for (let index = 1; index <= party.length; index++) {
    const mon = party[index - 1];
    if (index !== current && (mon.hp ?? 0) > 0) {
      target = index;
      break;
    }
  }
  if (target === undefined) return fail(self);
  const carried = self.volatile(attacker);
  for (const key of Effects.BATON_PASS_DROPS) delete carried[key];
  // The area moves with the baton rather than being copied: what the passer
  // leaves the field with is an empty one, the same as any other switch out.
  self.clearVolatile(attacker);
  self.emit({ kind: "baton-pass", side, index: target,
    text: Strings.get("%s passed the baton!", self.monName(attacker)) });
  if (side === "player") {
    self.playerIndex = target;
    self.player = party[target - 1];
    self.participants[target] = true;
    self.player.volatile = carried;
  } else {
    self.enemyIndex = target;
    self.enemy = party[target - 1];
    self.enemy.volatile = carried;
    // engine/battle/move_effects/baton_pass.asm:59
    self.resetParticipants();
  }
  const sent = side === "player" ? self.player : self.enemy;
  self.emit({ kind: "send", side, mon: sent,
    hp: sent.hp ?? 0, status: sent.status ?? false,
    level: sent.level, experience: sent.experience,
    text: Strings.get("Go! %s!", self.monName(sent)) });
};

// Lua: Battle.lua:2702
Battle.MOVE_EFFECTS.EFFECT_LIGHT_SCREEN = function (self: Battle, attacker: any) {
  const side = self.screens[self.sideOf(attacker)];
  if ((side.lightScreen ?? 0) > 0) return fail(self);
  side.lightScreen = Battle.SCREEN_TURNS;
  self.emit({ kind: "message",
    text: Strings.get("%s's SPCL.DEF rose!", self.monName(attacker)) });
};

// Lua: Battle.lua:2710
Battle.MOVE_EFFECTS.EFFECT_REFLECT = function (self: Battle, attacker: any) {
  const side = self.screens[self.sideOf(attacker)];
  if ((side.reflect ?? 0) > 0) return fail(self);
  side.reflect = Battle.SCREEN_TURNS;
  self.emit({ kind: "message",
    text: Strings.get("%s's DEFENSE rose!", self.monName(attacker)) });
};

// engine/battle/move_effects/safeguard.asm:1
// Lua: Battle.lua:2719
Battle.MOVE_EFFECTS.EFFECT_SAFEGUARD = function (self: Battle, attacker: any) {
  const side = self.screens[self.sideOf(attacker)];
  if ((side.safeguard ?? 0) > 0) return fail(self);
  side.safeguard = Battle.SCREEN_TURNS;
  self.emit({ kind: "message",
    text: Strings.get("%s's covered by a veil!", self.monName(attacker)) });
};

// BattleCommand_Curse (engine/battle/move_effects/curse.asm): two moves in
// one body.  A non-Ghost user trades a stage of Speed for one each of Attack
// and Defense, refused only when BOTH raises are already capped; a Ghost
// user pays half its max HP -- the cut can faint it -- to set
// SUBSTATUS_CURSE on the target, worth a quarter of max HP every turn
// (ResidualDamage's curse arm, Battle:tickSeedAndCurse).
// Lua: Battle.lua:2733
Battle.MOVE_EFFECTS.EFFECT_CURSE = function (self: Battle, attacker: any, defender: any) {
  let ghost = false;
  for (const type_ of self.battleTypes(attacker)) {
    if (type_ === "GHOST") ghost = true;
  }
  const name = self.monName(attacker);
  if (!ghost) {
    const stages = self.stages[self.sideOf(attacker)];
    if ((stages.attack ?? 0) >= Effects.MAX_STAGE
        && (stages.defense ?? 0) >= Effects.MAX_STAGE) {
      // curse.asm's `.cantraise`: AnimateFailedMove, then WontRiseAnymoreText.
      // The raising arm is the only one that calls AnimateCurrentMove.
      self.markMissed();
      self.emit({ kind: "message",
        text: Strings.get("%s's ATTACK won't rise anymore!", name) });
      return;
    }
    // engine/battle/move_effects/curse.asm:39
    if (truthy(self.moveEvent)) self.moveEvent.animParam = 1;
    // The cart's own order: Speed down first, then the two raises.  The
    // user's own drop is not Mist's business.
    self.changeStage(attacker, "speed", -1);
    self.changeStage(attacker, "attack", 1);
    self.changeStage(attacker, "defense", 1);
    return;
  }
  const target = self.volatile(defender);
  if (truthy(target.vanished) || (target.substitute ?? 0) > 0 || truthy(target.cursed)) {
    return fail(self);
  }
  target.cursed = true;
  const maxHp = attacker.maxHp ?? attacker.stats?.hp ?? 1;
  const cost = Math.max(1, Math.floor(maxHp / 2));
  attacker.hp = Math.max(0, (attacker.hp ?? 0) - cost);
  // AnimateCurrentMove has already run; SubtractHPFromUser adds nothing
  // (move_effects/curse.asm:70-76).
  self.emit({ kind: "damage", side: self.sideOf(attacker), amount: cost,
    hp: attacker.hp, anim: false });
  self.emit({ kind: "message",
    text: Strings.get("%s cut its own HP and put a CURSE on %s!", name,
      self.monName(defender)) });
};

// engine/battle/move_effects/belly_drum.asm:1, data/moves/effects.asm:1835
// Lua: Battle.lua:2778
Battle.MOVE_EFFECTS.EFFECT_BELLY_DRUM = function (self: Battle, attacker: any) {
  const stages = self.stages[self.sideOf(attacker)];
  if (!truthy(Effects.applyStage(stages, "attack", 2))) return fail(self);
  const maxHp = attacker.maxHp ?? attacker.stats?.hp ?? 1;
  // engine/battle/core.asm:1821, CheckUserHasEnoughHP :1874
  const half = Math.max(1, Math.floor(maxHp / 2));
  if ((attacker.hp ?? 0) <= half) return fail(self);
  attacker.hp = attacker.hp - half;
  self.emit({ kind: "damage", side: self.sideOf(attacker), amount: half,
    hp: attacker.hp, anim: false });
  stages.attack = Effects.MAX_STAGE;
  // data/text/battle.asm:1049
  self.emit({ kind: "message",
    text: Strings.get("%s\ncut its HP and", self.monName(attacker)) });
  self.emit({ kind: "message", text: Strings.get("maximized ATTACK!") });
};

// BattleCommand_LeechSeed (engine/battle/move_effects/leech_seed.asm): the
// flag sits on the SEEDED mon and ResidualDamage drains an eighth every turn
// into whoever stands on the other side by then.  A Grass target does not
// take it at all; a miss, a Substitute or a repeat all "evaded" -- and the
// move's own 90 accuracy rolls first, since its effect list carries
// checkhit.  All three refusals end on AnimateFailedMove, so none of them
// animates; only the seeding arm reaches AnimateCurrentMove.
// Lua: Battle.lua:2804
Battle.MOVE_EFFECTS.EFFECT_LEECH_SEED = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!truthy(sureHit)
      && !truthy(self.accuracyRoll(def, attacker, defender))) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("%s evaded the attack!", self.monName(defender)) });
    return;
  }
  for (const type_ of self.battleTypes(defender)) {
    if (type_ === "GRASS") {
      self.markMissed();
      self.emit({ kind: "message",
        text: Strings.get("It doesn't affect %s...", self.monName(defender)) });
      return;
    }
  }
  const target = self.volatile(defender);
  if ((target.substitute ?? 0) > 0 || truthy(target.leechSeed)) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("%s evaded the attack!", self.monName(defender)) });
    return;
  }
  target.leechSeed = true;
  self.emit({ kind: "message",
    text: Strings.get("%s was seeded!", self.monName(defender)) });
};

// BattleCommand_Spite (engine/battle/move_effects/spite.asm): 2-5 PP off the
// move the TARGET used last, clamped to what it has left.  The cart reads
// BATTLE_VARS_LAST_COUNTER_MOVE_OPP, so a target that has not moved yet -- or
// that answered with STRUGGLE, or whose slot is already dry -- falls into
// `.failed`, which is `jp PrintDidntAffect2`.  The effect list carries
// checkhit (data/moves/effects.asm:1366), and MOVE_EFFECTS handlers run ahead
// of useMove's own roll, so the roll is made here the way Leech Seed makes it.
//
// No party writeback: Battle.party IS save.party here and the move table
// this edits is the live one.
// Lua: Battle.lua:2845
Battle.MOVE_EFFECTS.EFFECT_SPITE = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  // DidntAffect2Text (data/text/battle.asm:888).  BattleCommand_Spite calls
  // AnimateCurrentMove itself and only on the way to the success text, so a
  // refused SPITE plays nothing.
  const didntAffect = (): void => {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("It didn't affect %s!", self.monName(defender)) });
  };
  if (!truthy(sureHit)
      && !truthy(self.accuracyRoll(def, attacker, defender))) {
    return didntAffect();
  }
  const last = self.volatile(defender).lastMove;
  if (!truthy(last) || last === Battle.STRUGGLE) return didntAffect();
  const entry = self.findMove(defender, last);
  if (!truthy(entry) || (entry.pp ?? 0) <= 0) return didntAffect();
  // `call BattleRandom / and %11 / inc a / inc a`, then `cp b / jr nc` keeps
  // the loss inside what the slot still holds.
  const loss = Math.min(rand(self.random, 4) + 2, entry.pp);
  entry.pp = entry.pp - loss;
  const moveName = (self.moveDef(last) ?? {}).name ?? last;
  self.emit({ kind: "message",
    text: Strings.get("%s's %s was reduced by %d!", self.monName(defender),
      moveName, loss) });
};

// The effect lists of the moves below carry checkhit unless NO_CHECKHIT says
// otherwise (data/moves/effects.asm); MOVE_EFFECTS handlers run ahead of
// useMove's own roll, so each makes it here.
function landed(self: Battle, def: any, attacker: any, defender: any, sureHit?: any): boolean {
  if (truthy((Effects.NO_CHECKHIT as Record<string, any>)[def.effect]) || truthy(sureHit)) return true;
  return truthy(self.accuracyRoll(def, attacker, defender));
}

// BattleCommand_Mist (effect_commands.asm): SUBSTATUS_MIST, once.
Battle.MOVE_EFFECTS.EFFECT_MIST = function (self: Battle, attacker: any) {
  const state = self.volatile(attacker);
  if (truthy(state.mist)) return fail(self);
  state.mist = true;
  self.emit({ kind: "message",
    text: Strings.get("%s's shrouded in MIST!", self.monName(attacker)) });
};

// BattleCommand_FocusEnergy (effect_commands.asm): SUBSTATUS_FOCUS_ENERGY,
// once -- the +1 critical level BattleCommand_Critical reads.
Battle.MOVE_EFFECTS.EFFECT_FOCUS_ENERGY = function (self: Battle, attacker: any) {
  const state = self.volatile(attacker);
  if (truthy(state.focusEnergy)) return fail(self);
  state.focusEnergy = true;
  self.emit({ kind: "message",
    text: Strings.get("%s's getting pumped!", self.monName(attacker)) });
};

// BattleCommand_ResetStats (HAZE): every stat level on both sides back to
// neutral; it never fails.
Battle.MOVE_EFFECTS.EFFECT_RESET_STATS = function (self: Battle) {
  for (const side of ["player", "enemy"]) {
    const stages = self.stages[side];
    if (!truthy(stages)) continue;
    for (const key of Object.keys(stages)) stages[key] = 0;
  }
  self.emit({ kind: "message", text: Strings.get("All stat changes\nwere eliminated!") });
};

// BattleCommand_Conversion (move_effects/conversion.asm): the type of one of
// the user's moves, picked at random, that is neither "???" nor one of the
// user's own types, written to both type bytes.
Battle.MOVE_EFFECTS.EFFECT_CONVERSION = function (self: Battle, attacker: any) {
  const own = self.battleTypes(attacker);
  const picks: string[] = [];
  for (const move of attacker.moves ?? []) {
    const t = (self.moveDef(move.id) ?? {}).type;
    if (!truthy(t) || t === "CURSE_TYPE" || own.includes(t)) continue;
    picks.push(t);
  }
  if (picks.length === 0) return fail(self);
  const type_ = picks[rand(self.random, picks.length)]!;
  self.volatile(attacker).typeOverride = [type_, type_];
  self.emit({ kind: "message", text: Strings.get("%s transformed into the %s-type!",
    self.monName(attacker), typeName(self, type_)) });
};

// BattleCommand_Conversion2 (move_effects/conversion2.asm): a random type
// that resists (or is immune to) the type of the move the TARGET used last,
// on both of the user's type bytes.  No last move, or a "???" one, fails.
Battle.MOVE_EFFECTS.EFFECT_CONVERSION2 = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!landed(self, def, attacker, defender, sureHit)) return fail(self);
  const last = self.volatile(defender).lastMove;
  const lastType = truthy(last) ? (self.moveDef(last) ?? {}).type : undefined;
  if (!truthy(lastType) || lastType === "CURSE_TYPE") return fail(self);
  // the draw: `and $1f` against TYPES_END, the UNUSED_TYPES block rejected,
  // then BattleCheckTypeMatchup under EFFECTIVE -- uniform over what passes
  const chart = self.data.type_chart ?? {};
  const matchups = chart.matchups;
  const picks: string[] = [];
  for (const [id, t] of Object.entries(chart.types ?? {}) as [string, any][]) {
    const index = t.index ?? -1;
    if (!(index >= 0 && index < 10) && !(index >= 20 && index < 28)) continue;
    if (Damage.typeMultiplier(lastType, [id], matchups) < 10) picks.push(id);
  }
  if (picks.length === 0) return fail(self);
  const type_ = picks[rand(self.random, picks.length)]!;
  self.volatile(attacker).typeOverride = [type_, type_];
  self.emit({ kind: "message", text: Strings.get("%s transformed into the %s-type!",
    self.monName(attacker), typeName(self, type_)) });
};

// The type's printed name (GetTypeName): "???" for CURSE_TYPE.
function typeName(self: Battle, type_: string): string {
  const t = ((self.data.type_chart ?? {}).types ?? {})[type_];
  return (truthy(t) && t.name) || type_;
}

// BattleCommand_Sketch (move_effects/sketch.asm): the target's last move,
// for good -- the party struct as well as the battle one, at the move's own
// PP.  Not in a link battle; not through a Substitute or at a transformed
// target; not with no last move, STRUGGLE, or one the user already knows.
Battle.MOVE_EFFECTS.EFFECT_SKETCH = function (self: Battle, attacker: any, defender: any,
    _def?: any, moveId?: any) {
  const target = self.volatile(defender);
  const last = target.lastMove;
  const didntAffect = (): void => {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("It didn't affect %s!", self.monName(defender)) });
  };
  if (truthy(self.linkBattle) || (target.substitute ?? 0) > 0 || truthy(target.transformed)
      || !truthy(last) || last === Battle.STRUGGLE || truthy(self.findMove(attacker, last))) {
    return didntAffect();
  }
  const sketchId = moveId ?? "SKETCH";
  const pp = (self.moveDef(last) ?? {}).pp ?? 5;
  let wrote = false;
  for (const moves of [attacker.moves, self.volatile(attacker).preTransform?.moves,
    self.volatile(attacker).preMimic]) {
    for (const move of moves ?? []) {
      if (move.id === sketchId) {
        move.id = last;
        move.pp = pp;
        move.maxPp = pp;
        move.ppUps = 0;
        wrote = true;
        break;
      }
    }
  }
  if (!wrote) return didntAffect();
  self.emit({ kind: "message", text: Strings.get("%s SKETCHED %s!",
    self.monName(attacker), (self.moveDef(last) ?? {}).name ?? last) });
};

// BattleCommand_Mimic (move_effects/mimic.asm): the target's last move in
// place of MIMIC, at 5 PP, in the battle struct only (put back by
// untransform, on the routes that reload it).
Battle.MOVE_EFFECTS.EFFECT_MIMIC = function (self: Battle, attacker: any, defender: any,
    def: any, moveId?: any, sureHit?: any) {
  if (!landed(self, def, attacker, defender, sureHit)) return fail(self);
  const last = self.volatile(defender).lastMove;
  if (!truthy(last) || last === Battle.STRUGGLE || truthy(self.findMove(attacker, last))) {
    return fail(self);
  }
  const mimicId = moveId ?? "MIMIC";
  const moves: any[] = attacker.moves ?? [];
  let slot = -1;
  for (let i = moves.length - 1; i >= 0; i--) if (moves[i].id === mimicId) slot = i;
  if (slot < 0) return fail(self);
  const state = self.volatile(attacker);
  // the other slots stay the very entries they were, so their PP still
  // spends from the mon's own moves
  if (!truthy(state.preMimic)) state.preMimic = moves;
  attacker.moves = moves.map((m, i) => (i === slot ? { id: last, pp: 5, maxPp: 5 } : m));
  self.emit({ kind: "message", text: Strings.get("%s learned %s!",
    self.monName(attacker), (self.moveDef(last) ?? {}).name ?? last) });
};

// BattleCommand_Nightmare (move_effects/nightmare.asm): a sleeping target
// that is not hidden, not behind a Substitute and not already dreaming.
Battle.MOVE_EFFECTS.EFFECT_NIGHTMARE = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  const target = self.volatile(defender);
  if (!landed(self, def, attacker, defender, sureHit) || truthy(target.vanished)
      || (target.substitute ?? 0) > 0 || defender.status !== "sleep" || truthy(target.nightmare)) {
    return fail(self);
  }
  target.nightmare = true;
  self.emit({ kind: "message",
    text: Strings.get("%s started to have a NIGHTMARE!", self.monName(defender)) });
};

// BattleCommand_DestinyBond (move_effects/destiny_bond.asm): the flag; the
// KO it answers is in dealDamage, the clearing in the turn loop.
Battle.MOVE_EFFECTS.EFFECT_DESTINY_BOND = function (self: Battle, attacker: any) {
  self.volatile(attacker).destinyBond = true;
  self.emit({ kind: "message", text: Strings.get("%s's trying to take its opponent with it!",
    self.monName(attacker)) });
};

// BattleCommand_HealBell (move_effects/heal_bell.asm): SUBSTATUS_NIGHTMARE
// off, then the status byte of the battler and of every member of the
// user's party cleared.
Battle.MOVE_EFFECTS.EFFECT_HEAL_BELL = function (self: Battle, attacker: any) {
  self.volatile(attacker).nightmare = undefined;
  const party = attacker === self.player ? self.party : self.enemyParty;
  for (const mon of [attacker, ...(party ?? [])]) {
    if (!truthy(mon)) continue;
    delete mon.status;
    delete mon.statusTurns;
    delete mon.toxicCount;
  }
  self.emit({ kind: "status", side: self.sideOf(attacker), status: undefined,
    text: Strings.get("A bell chimed!") });
};

// BattleCommand_PsychUp (move_effects/psych_up.asm): every stat level of the
// target copied onto the user; a target with none moved fails.
Battle.MOVE_EFFECTS.EFFECT_PSYCH_UP = function (self: Battle, attacker: any, defender: any) {
  const theirs = self.stages[self.sideOf(defender)] ?? {};
  const mine = self.stages[self.sideOf(attacker)] ?? {};
  if (!Object.values(theirs).some((v) => (v ?? 0) !== 0)) return fail(self);
  for (const key of Object.keys(theirs)) mine[key] = theirs[key];
  self.emit({ kind: "message", text: Strings.get("%s copied the stat changes of %s!",
    self.monName(attacker), self.monName(defender)) });
};

// SWAGGER (data/moves/effects.asm): checkhit, the TARGET's Attack up two
// (switchturn / attackup2 -- its own stat, so neither Mist nor a Substitute
// stops it, and a maxed one just prints nothing), then confusetarget, which
// quietly passes over a Substitute, a Safeguard or a target already
// confused.
Battle.MOVE_EFFECTS.EFFECT_SWAGGER = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!landed(self, def, attacker, defender, sureHit)) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("%s's attack missed!", self.monName(attacker)) });
    return;
  }
  const applied = Effects.applyStage(self.stages[self.sideOf(defender)], "attack", 2);
  if (truthy(applied)) {
    self.emit({ kind: "stage", side: self.sideOf(defender), stat: "attack",
      stages: applied, text: Effects.stageMessage(self.monName(defender), "attack", applied as number) });
  }
  const target = self.volatile(defender);
  if ((target.substitute ?? 0) > 0 || truthy(target.confuseCount)
      || truthy(self.safeguarded(defender))) {
    return;
  }
  self.applyConfusion(defender, undefined, attacker);
};

// BattleCommand_PainSplit (move_effects/pain_split.asm): both battlers set to
// the average of their HP, neither past its own max; a miss or a Substitute
// is DidntAffect2.
Battle.MOVE_EFFECTS.EFFECT_PAIN_SPLIT = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!landed(self, def, attacker, defender, sureHit)
      || (self.volatile(defender).substitute ?? 0) > 0) {
    self.markMissed();
    self.emit({ kind: "message",
      text: Strings.get("It didn't affect %s!", self.monName(defender)) });
    return;
  }
  const average = Math.floor(((attacker.hp ?? 0) + (defender.hp ?? 0)) / 2);
  // the user's bar, then the target's (UpdateHPBar for each side)
  for (const mon of [attacker, defender]) {
    const maxHp = mon.maxHp ?? mon.stats?.hp ?? 1;
    const before = mon.hp ?? 0;
    const after = Math.min(average, maxHp);
    mon.hp = after;
    if (after > before) {
      self.emit({ kind: "heal", side: self.sideOf(mon), amount: after - before, hp: after });
    } else if (after < before) {
      self.emit({ kind: "damage", side: self.sideOf(mon), amount: before - after,
        hp: after, anim: false });
    }
  }
  self.emit({ kind: "message", text: Strings.get("The battlers\nshared pain!") });
};

// BattleCommand_ArenaTrap (effect_commands.asm:6238): Mean Look and Spider
// Web set SUBSTATUS_CANT_RUN on the USER's side, meaning "my opponent cannot
// run or switch" -- which is why the pin dies with its user (a switch drops
// the volatile) and why TryEnemyFlee reads the PLAYER's substatus to hold a
// roamer.  No accuracy roll: the effect list has no checkhit, only the
// hidden-target and repeat guards.
// Lua: Battle.lua:2879
Battle.MOVE_EFFECTS.EFFECT_MEAN_LOOK = function (self: Battle, attacker: any, defender: any) {
  if (truthy(self.volatile(defender).vanished)
      || truthy(self.volatile(attacker).trapsTarget)) {
    return fail(self);
  }
  self.volatile(attacker).trapsTarget = true;
  self.emit({ kind: "message",
    text: Strings.get("%s can't escape now!", self.monName(defender)) });
};

// engine/battle/move_effects/attract.asm:1, CheckOppositeGender :24
// data/moves/effects.asm:1599
// Lua: Battle.lua:2891
Battle.MOVE_EFFECTS.EFFECT_ATTRACT = function (self: Battle, attacker: any, defender: any,
    def: any, _moveId?: any, sureHit?: any) {
  if (!truthy(sureHit) && !truthy(self.accuracyRoll(def, attacker, defender))) {
    return fail(self);
  }
  const mine = attacker.gender ?? "unknown";
  const theirs = defender.gender ?? "unknown";
  if (mine === "unknown" || theirs === "unknown" || mine === theirs) {
    return fail(self);
  }
  const target = self.volatile(defender);
  if (truthy(target.vanished) || truthy(target.attract)) return fail(self);
  target.attract = true;
  // data/text/battle.asm:1001
  self.emit({ kind: "message",
    text: Strings.get("%s\nfell in love!", self.monName(defender)) });
};

// BattleCommand_ForceSwitch (effect_commands.asm:4913).  Fails outright for
// BATTLETYPE_FORCESHINY and BATTLETYPE_TRAP.  Against a WILD mon the battle
// simply ENDS -- either direction writes DRAW into wBattleResult, which is
// what makes a Roared-away roamer bank its HP -- with the level ladder
// deciding: the user's level at or above the target's succeeds outright,
// and below it one re-rolled byte can still get past a quarter of the
// target's level.  In a TRAINER battle the user must be moving SECOND (both
// arms read wEnemyGoesFirst) and a random other able mon is dragged out.
// Lua: Battle.lua:2917
Battle.MOVE_EFFECTS.EFFECT_FORCE_SWITCH = function (self: Battle, attacker: any, defender: any,
    def: any, moveId?: any, sureHit?: any) {
  if (self.battleType === Battle.BATTLETYPE_FORCESHINY
      || self.battleType === Battle.BATTLETYPE_TRAP) {
    return fail(self);
  }
  // checkhit runs ahead of forceswitch in the effect list; `.missed` fails.
  if (!truthy(sureHit)
      && !truthy(self.accuracyRoll(def, attacker, defender))) {
    return fail(self);
  }

  if (truthy(self.wild)) {
    // `.wild_force_flee` / `.wild_succeed_playeristarget`.
    const userLevel = attacker.level ?? 1;
    const targetLevel = defender.level ?? 1;
    let succeeds = userLevel >= targetLevel;
    if (!succeeds) {
      const roll = self.rollBelow(Math.min(256, userLevel + targetLevel + 1));
      succeeds = roll >= idiv(targetLevel, 4);
    }
    if (!succeeds) return fail(self);
    self.over = true;
    self.outcome = "fled";
    // FledInFearText for ROAR, BlownAwayText for everything else, naming
    // the mon that was sent away.
    self.forcedSwitch = true;
    const source = moveId === "ROAR"
      ? Strings.source("%s fled in fear!")
      : Strings.source("%s was blown away!");
    self.emit({ kind: "run", side: self.sideOf(defender),
      text: Strings.get(source, self.monName(defender)) });
    return;
  }

  // `.trainer` / `.vs_trainer`: the user has to be moving second, and the
  // other side needs someone able on the bench.
  if (self.firstMover === self.sideOf(attacker)) return fail(self);
  const party: any[] = defender === self.player ? self.party : self.enemyParty;
  const active = defender === self.player ? self.playerIndex
    : self.enemyIndex;
  const bench: number[] = [];
  for (let index = 1; index <= party.length; index++) {
    const mon = party[index - 1];
    if (index !== active && (mon.hp ?? 0) > 0 && !truthy(mon.isEgg)) {
      bench.push(index);
    }
  }
  if (bench.length === 0) return fail(self);
  const pick = bench[rand(self.random, bench.length)]!;
  self.clearVolatile(defender);
  const incoming = party[pick - 1];
  if (defender === self.player) {
    self.playerIndex = pick;
    self.player = incoming;
    self.participants[pick] = true;
    self.stages.player = Battle.newStages();
    self.checkAmuletCoin(incoming);
  } else {
    self.enemyIndex = pick;
    self.enemy = incoming;
    self.stages.enemy = Battle.newStages();
    // ForceEnemySwitch (engine/battle/core.asm:2937)
    self.resetParticipants();
  }
  self.emit({ kind: "send", side: self.sideOf(incoming), mon: incoming,
    hp: incoming.hp ?? 0, status: incoming.status ?? false,
    level: incoming.level, experience: incoming.experience,
    text: Strings.get("%s was dragged out!", self.monName(incoming)) });
  self.breakTrapsOnSend(incoming);
  self.spikesDamage(incoming);
  // wForcedSwitch: the round ends here, skipping the between-turn effects.
  self.forcedSwitch = true;
};

// BattleCommand_Teleport (engine/battle/move_effects/teleport.asm).  Fails
// outright for BATTLETYPE_FORCESHINY/TRAP, for a trapped user, and in any
// TRAINER battle; in a WILD battle the level ladder is identical to
// EFFECT_FORCE_SWITCH's.
// Lua: Battle.lua:2996
Battle.MOVE_EFFECTS.EFFECT_TELEPORT = function (self: Battle, attacker: any, defender: any) {
  if (self.battleType === Battle.BATTLETYPE_FORCESHINY
      || self.battleType === Battle.BATTLETYPE_TRAP
      || truthy(self.volatile(defender).trapsTarget)) {
    return fail(self);
  }
  if (!truthy(self.wild)) return fail(self);

  const userLevel = attacker.level ?? 1;
  const targetLevel = defender.level ?? 1;
  let succeeds = userLevel >= targetLevel;
  if (!succeeds) {
    const roll = self.rollBelow(Math.min(256, userLevel + targetLevel + 1));
    succeeds = roll >= idiv(targetLevel, 4);
  }
  if (!succeeds) return fail(self);

  self.over = true;
  self.outcome = "fled";
  self.forcedSwitch = true;
  self.emit({ kind: "run", side: self.sideOf(attacker),
    text: Strings.get("%s fled from battle!", self.monName(attacker)) });
};

// The effect-record fold (Battle.lua:3045-3055).  Later loops overwrite
// earlier ones; within a loop each id is written once, so pairs() order only
// decides MOVE_EFFECT_RECORDS' key order (JS insertion order here).
// Lua: Battle.lua:3047
for (const id of Object.keys(Battle.MOVE_EFFECTS)) {
  Battle.MOVE_EFFECT_RECORDS[id] = { kind: "primary", run: Battle.MOVE_EFFECTS[id] };
}
for (const id of Object.keys(Battle.STATUS_EFFECTS)) {
  Battle.MOVE_EFFECT_RECORDS[id] = { kind: "primary", status: Battle.STATUS_EFFECTS[id] };
}
for (const id of Object.keys(Battle.SECONDARY_EFFECTS)) {
  Battle.MOVE_EFFECT_RECORDS[id] = { kind: "secondary", status: Battle.SECONDARY_EFFECTS[id] };
}

// Gold's persistent conditions as records (Battle.lua:3118-3162).  The Gen 1
// fields keep their Gen 1 meaning (label / hudLabel, catchBonus, statPenalty,
// beforeMove, beforeMovePriority, residual); their SIGNATURES are Gold's.
// Gen 2 adds inflictText (the tail of the landing line), catchBonusIntended
// (the bonus the cart MEANT to give: the `and` that tests for sleep/freeze
// leaves burn, poison and paralysis at zero, and this is the 5 `fixBugs`
// asks for), substatus (confusion is SUBSTATUS_CONFUSED, not a status byte)
// and healClass (the StatusHealingActions class that cures it).
// Every consumer reads through Battle.statusRecordFor, so a mod's sixth
// status inflicts, chips, blocks a turn and cuts a stat like the vanilla six.
// Lua: Battle.lua:3163
Battle.STATUSES = {
  sleep: {
    id: "sleep", label: Strings.source("SLP"),
    healClass: "slp",
    inflictText: Strings.source(" fell asleep!"),
    catchBonus: 10, catchBonusIntended: 10,
    // BattleCommand_SleepTarget's .random_loop rerolls 0 and SLP_MASK before
    // `inc a`, so sleep opens at 2 (effect_commands.asm:3591-3598, #1707).
    // Crystal masks the roll to %011 in the Battle Tower, capping it at 4
    // (../pokecrystal/engine/battle/effect_commands.asm:3609-3613).
    // Lua: Battle.lua:3173
    onInflict: (battle: any, mon: any): void => {
      mon.statusTurns = rand(battle.random, truthy(battle.inBattleTowerBattle) ? 3 : 6) + 2;
    },
    beforeMovePriority: 40,
    // Lua: Battle.lua:3177
    beforeMove: (battle: any, mon: any, name: string): boolean => {
      mon.statusTurns = (mon.statusTurns ?? 1) - 1;
      if (mon.statusTurns <= 0) {
        delete mon.status;
        delete mon.statusTurns;
        // waking ends SUBSTATUS_NIGHTMARE (effect_commands.asm, .woke_up)
        if (truthy(mon.volatile)) mon.volatile.nightmare = undefined;
        // engine/battle/effect_commands.asm:175-181
        battle.emit({ kind: "status", side: battle.sideOf(mon), status: undefined,
          text: Strings.get("%s woke up!", name) });
        return true;
      }
      battle.emit({ kind: "message",
        text: Strings.get("%s is fast asleep!", name) });
      return false;
    },
  },
  poison: {
    id: "poison", label: Strings.source("PSN"),
    healClass: "psn",
    inflictText: Strings.source(" was poisoned!"),
    catchBonus: 0, catchBonusIntended: 5,
    // Lua: Battle.lua:3197
    residual: (_battle: any, _mon: any, maxHp: number): [number, string] => {
      return [Math.max(1, Math.floor(maxHp / Battle.POISON_FRACTION)),
        Strings.source(" is hurt by poison!")];
    },
  },
  toxic: {
    // SUBSTATUS_TOXIC rides the poison byte, so the HUD says PSN either way.
    id: "toxic", label: Strings.source("PSN"),
    healClass: "psn",
    inflictText: Strings.source(" was badly poisoned!"),
    catchBonus: 0, catchBonusIntended: 5,
    // Lua: Battle.lua:3208
    onInflict: (_battle: any, mon: any): void => { mon.toxicCounter = 1; },
    // Toxic ramps: n/16 of max HP on the nth turn.
    // Lua: Battle.lua:3210
    residual: (_battle: any, mon: any, maxHp: number): [number, string] => {
      const counter = mon.toxicCounter ?? 1;
      mon.toxicCounter = counter + 1;
      return [Math.max(1, Math.floor(maxHp * counter / 16)),
        Strings.source(" is hurt by poison!")];
    },
  },
  paralyze: {
    id: "paralyze", label: Strings.source("PAR"),
    healClass: "par",
    inflictText: Strings.source(" is paralyzed! It may be unable to move!"),
    catchBonus: 0, catchBonusIntended: 5,
    statPenalty: { stat: "speed", div: Battle.PARALYSIS_SPEED_DIVISOR },
    // CheckPlayerTurn's last arm: after the flinch and confusion block.
    beforeMovePriority: 10,
    // Lua: Battle.lua:3225
    beforeMove: (battle: any, _mon: any, name: string): boolean => {
      if (rand(battle.random, Battle.PARALYSIS_SKIP_CHANCE) !== 0) {
        return true;
      }
      battle.emit({ kind: "message",
        text: Strings.get("%s's fully paralyzed!", name) });
      return false;
    },
  },
  burn: {
    id: "burn", label: Strings.source("BRN"),
    healClass: "brn",
    inflictText: Strings.source(" was burned!"),
    catchBonus: 0, catchBonusIntended: 5,
    statPenalty: { stat: "attack", div: Battle.BURN_ATTACK_DIVISOR },
    // Lua: Battle.lua:3240
    residual: (_battle: any, _mon: any, maxHp: number): [number, string] => {
      return [Math.max(1, Math.floor(maxHp / Battle.BURN_FRACTION)),
        Strings.source(" is hurt by its burn!")];
    },
  },
  freeze: {
    id: "freeze", label: Strings.source("FRZ"),
    healClass: "frz",
    inflictText: Strings.source(" was frozen solid!"),
    catchBonus: 10, catchBonusIntended: 10,
    beforeMovePriority: 30,
    // Lua: Battle.lua:3251
    beforeMove: (battle: any, mon: any, name: string): boolean => {
      if (rand(battle.random, Battle.THAW_CHANCE) === 0) {
        delete mon.status;
        // engine/battle/effect_commands.asm:6289-6290
        battle.emit({ kind: "status", side: battle.sideOf(mon), status: undefined,
          text: Strings.get("%s thawed out!", name) });
        return true;
      }
      battle.emit({ kind: "message",
        text: Strings.get("%s is frozen solid!", name) });
      return false;
    },
  },
  // SUBSTATUS_CONFUSED: it lives in the volatile beside the major status, so
  // applyStatus hands it to applyConfusion rather than writing mon.status.
  // It is a record all the same because its landing line is one of the seven
  // src/core/gen2/ItemEffects.lua is held against.
  confuse: {
    id: "confuse", label: Strings.source("CONFUSED"),
    inflictText: Strings.source(" became confused!"),
    substatus: true,
  },
};

// The derived view of the records (see the declaration in the class).
// Lua: Battle.lua:3293
for (const id of Object.keys(Battle.STATUSES)) {
  Battle.STATUS_TEXT[id] = Battle.STATUSES[id]!.inflictText!;
}
// ---- Battle.lua PART C module-level code (Lua lines 4301, 4735-5041, 5395-5486).

// Encore forces the move; Disable forbids one.  Both are read by the screen
// (to grey out the move list) and by the enemy's own choice.
// engine/battle/core.asm:561-566
// Lua: Battle.lua:4301
function encoredMove(state: any, mon: any): any {
  if (!truthy(state.encore)) return undefined;
  for (const move of (mon.moves ?? [])) {
    if (move.id === state.encore && (move.pp ?? 0) > 0) {
      return state.encore;
    }
  }
  state.encore = undefined;
  state.encoreTurns = undefined;
  return undefined;
}

// Run one turn.  `action` is:
//   { kind = "move", move = <id> }
//   { kind = "switch", index = n }          (n: the 1-based party slot)
//   { kind = "run" }
//   { kind = "item", item = <id>, target = n }  (handled by the caller, which
//       applies the effect and then calls this with kind = "item" so the enemy
//       still gets its turn)
// `enemyAction` (link battles only) is the same shape, or { kind = "skip" }.
// Returns the drained event queue.
// Lua: Battle.lua:4735
function runTurn(self: any, action?: any, enemyAction?: any): any[] {
  if (truthy(self.over)) return self.takeEvents();
  self.turn = self.turn + 1;
  action = truthy(action) ? action : { kind: "move" };
  // HandleBerserkGene sits at the top of BattleTurn's loop
  // (engine/battle/core.asm:160), player first then enemy, so a holder
  // fires on its first turn out whether it started the battle or switched
  // in.  Consuming the item is what keeps it one-shot.
  self.checkBerserkGene(self.player);
  self.checkBerserkGene(self.enemy);
  // Counter and Mirror Coat answer damage taken *this* turn, so the tally
  // starts empty (BattleCommand_Counter reads wCurDamage, which the turn
  // clears).
  self.volatile(self.player).tookThisTurn = undefined;
  self.volatile(self.enemy).tookThisTurn = undefined;
  // Set by resolveFaints; per-round, so it can never leak into the next one.
  self.faintInterrupt = undefined;

  if (action.kind === "run") {
    if (self.tryRun()) return self.takeEvents();
    // Only the failed ROLL costs the turn.  .cant_escape_2 writes
    // BATTLEPLAYERACTION_USEITEM before printing its line, so the round
    // proceeds; .cant_escape and .cant_run_from_trainer reopen the menu with the
    // turn unspent (engine/battle/core.asm:5035-5038), so a refused RUN never
    // bought the enemy a free attack.
    if (truthy(self.runRefused)) return self.takeEvents();
    self.cancelBide(self.player);
    action = { kind: "skip" };
  }

  if (action.kind === "switch") {
    self.switch(action.index);
    action = { kind: "skip" };
  }

  // XItemEffect's tail: the four X items award HAPPINESS_USEDXITEM to
  // wCurBattleMon, i.e. whoever is out, not whoever the PACK was pointed at.
  // The caller applies the item's own effect and then hands the turn here, so
  // this is where the award lands.
  if (action.kind === "item" && truthy(Battle.X_ITEMS[action.item])) {
    Happiness.change(self.player, "USEDXITEM");
  }
  // engine/battle/core.asm:572-573 into :627-629; a switch takes :570-571
  // instead and keeps the store.
  if (action.kind === "item") self.cancelBide(self.player);

  // AI_SwitchOrTryItem runs BEFORE the move is chosen: a trainer that decides
  let enemyActed: boolean;
  let enemyMoveId: any;
  if (truthy(enemyAction)) {
    if (enemyAction.kind === "switch") {
      self.switchEnemy(tonumber(enemyAction.index) ?? 0);
      enemyActed = true;
    } else if (enemyAction.kind === "item") {
      self.enemyUseItem(enemyAction.item);
      enemyActed = true;
    } else if (enemyAction.kind === "move") {
      enemyActed = false;
      enemyMoveId = enemyAction.move;
    } else {
      enemyActed = true;
    }
  } else {
    enemyActed = self.enemyTrySwitchOrItem();
    if (!enemyActed) {
      const picked = self.enemyMove();
      enemyMoveId = truthy(picked) ? picked : undefined;
    } else {
      enemyMoveId = undefined;
    }
  }

  // battle.turn_started, where BattleState:resolveTurn raises it on Gen 1:
  // once both sides have chosen and before either acts.  The payload's copies
  // carry both `id` and `move` spellings.
  if (Runtime.wants("battle.turn_started")) {
    Runtime.emit("battle.turn_started", {
      battle: self, turn: self.turn,
      playerAction: { kind: action.kind, id: action.move,
        move: action.move, index: action.index,
        item: action.item },
      enemyAction: truthy(enemyMoveId)
        ? { kind: "move", id: enemyMoveId, move: enemyMoveId } : undefined,
    });
  }
  self.turnOpen = true;

  // A switch or item always resolves before the enemy's move; otherwise Speed
  // decides.
  let playerFirst: boolean;
  if (action.kind === "skip" || action.kind === "item") {
    playerFirst = true;
  } else if (truthy(self.linkBattle) && enemyActed) {
    playerFirst = false;
  } else if (Runtime.wantsHook("battle.turn_order")) {
    // battle.turn_order, the same hook BattleState:resolveTurn calls on Gen 1
    // and with the same five arguments: both battlers, both move records, and
    // a ctx carrying the rng.  Gen 2's ordering reads move IDS, so the ids are
    // in the ctx as playerMove / enemyMove and that is what vanilla resolves.
    playerFirst = truthy(Runtime.call("battle.turn_order",
      (_p: any, _pm: any, _e: any, _em: any, c: any) => {
        return c.battle.orderOf(c.playerMove, c.enemyMove) === "player";
      }, self.player, truthy(action.move) ? self.moveDef(action.move) : undefined,
      self.enemy, truthy(enemyMoveId) ? self.moveDef(enemyMoveId) : undefined,
      { battle: self, rng: self.roller(), random: self.random,
        playerMove: action.move, enemyMove: enemyMoveId }));
  } else {
    playerFirst = self.orderOf(action.move, enemyMoveId) === "player";
  }
  // wEnemyGoesFirst, which BattleCommand_ForceSwitch's two trainer arms
  // read: Roar and Whirlwind only work for a user moving SECOND.
  self.firstMover = playerFirst ? "player" : "enemy";

  const playerAttack = (): void => {
    if (action.kind !== "move") return;
    if (truthy(self.linkBattle) && (self.player.hp ?? 0) <= 0) return;
    let move = action.move;
    // An encored mon has no choice, whatever the menu said.
    const forced = self.forcedMove(self.player);
    if (truthy(forced)) move = forced;
    // .CheckPlayerHasUsableMoves: a mon with nothing left to spend attacks
    // with STRUGGLE rather than losing the turn.  The second half of a
    // two-turn move is exempt.  Whatever the menu handed us, a mon with a
    // stored charge move uses THAT.
    const stored = self.volatile(self.player).chargeMove;
    if (truthy(stored)) move = stored;
    // engine/battle/core.asm:558-598 settles wCurPlayerMove before
    // engine/battle/effect_commands.asm:193 reads it.
    if (!truthy(self.canAct(self.player, move))) return;
    // CheckPlayerLockedIn quits before .CheckPlayerHasUsableMoves and before
    // checkobedience, so a locked Rollout or Thrash is exempt from the
    // Struggle substitution and the obedience roll.
    const charging = self.volatile(self.player).chargeMove === move
      || self.lockedInMove(self.player) === move;
    // engine/battle/core.asm:5058, and data/moves/effects.asm:796 keeps
    // `checkobedience`.
    const bideLocked = self.fightLockedMove(self.player) === move;
    if (!charging && !bideLocked
        && !truthy(self.hasUsableMoves(self.player))) {
      self.emit({ kind: "message",
        text: Strings.get("%s has no moves left!", self.monName(self.player)) });
      move = Battle.STRUGGLE;
    }
    // CheckPlayerTurn's disabled arm spends the turn, whatever was selected
    // (engine/battle/effect_commands.asm:314-326).
    if (self.moveDisabled(self.player, move)) {
      // MoveDisabled fails the stored charge (:599-603) and CantMove brings a
      // vanished FLY/DIG user back (:364-368).
      const state = self.volatile(self.player);
      state.chargeMove = undefined;
      state.vanished = undefined;
      const moveDef = self.moveDef(move);
      const moveName = (truthy(moveDef) && truthy(moveDef.name)) ? moveDef.name : (truthy(move) ? move : "?");
      self.emit({ kind: "message",
        text: Strings.get("%s's %s is DISABLED!", self.monName(self.player),
          moveName) });
      return;
    }
    // BattleCommand_CheckObedience runs at the head of the move's effect
    // list, after the status gates and before PP is spent; the second half
    // of a charge move is exempt (CheckUserIsCharging).
    if (!charging && self.checkObedience(move)) return;
    self.useMove(self.player, self.enemy, move);
  };
  const enemyAttack = (): void => {
    if (enemyActed) return;
    if ((self.enemy.hp ?? 0) <= 0) return;
    // TryEnemyFlee sits here in both of the cart's turn orders, ahead of the
    // enemy's move and behind the faint checks.
    if (self.tryEnemyFlee()) return;
    if (truthy(self.linkBattle)) {
      const forced = self.forcedMove(self.enemy);
      if (truthy(forced)) enemyMoveId = forced;
      const stored = self.volatile(self.enemy).chargeMove;
      if (truthy(stored)) enemyMoveId = stored;
      if (!truthy(self.canAct(self.enemy, enemyMoveId))) return;
      const charging = stored === enemyMoveId
        || self.lockedInMove(self.enemy) === enemyMoveId;
      const bideLocked = self.fightLockedMove(self.enemy) === enemyMoveId;
      if (!charging && !bideLocked
          && !truthy(self.hasUsableMoves(self.enemy))) {
        self.emit({ kind: "message",
          text: Strings.get("%s has no moves left!", self.monName(self.enemy)) });
        enemyMoveId = Battle.STRUGGLE;
      }
      if (!truthy(enemyMoveId)) enemyMoveId = Battle.STRUGGLE;
      if (self.moveDisabled(self.enemy, enemyMoveId)) {
        const state = self.volatile(self.enemy);
        state.chargeMove = undefined;
        state.vanished = undefined;
        const moveDef = self.moveDef(enemyMoveId);
        const moveName = (truthy(moveDef) && truthy(moveDef.name)) ? moveDef.name : (truthy(enemyMoveId) ? enemyMoveId : "?");
        self.emit({ kind: "message", text: Strings.get("%s's %s is DISABLED!",
          self.monName(self.enemy), moveName) });
        return;
      }
      self.useMove(self.enemy, self.player, enemyMoveId);
      return;
    }
    if (!truthy(enemyMoveId)) {
      // `.struggle` (engine/battle/core.asm:5630-5632) sets STRUGGLE and
      // finishes silently: only .force_struggle (core.asm:5311-5317) ever
      // prints BattleText_MonHasNoMovesLeft.  Returning here instead left a dry
      // enemy unable to act at all, so a battle where both sides had run out
      // could never end.
      enemyMoveId = Battle.STRUGGLE;
    }
    if (!truthy(self.canAct(self.enemy, enemyMoveId))) return;
    // CheckEnemyTurn's disabled arm (engine/battle/effect_commands.asm:562-574):
    // the AI chose before the player's Disable landed, so the turn is spent here.
    if (self.moveDisabled(self.enemy, enemyMoveId)) {
      const state = self.volatile(self.enemy);
      state.chargeMove = undefined;
      state.vanished = undefined;
      const moveDef = self.moveDef(enemyMoveId);
      const moveName = (truthy(moveDef) && truthy(moveDef.name)) ? moveDef.name : (truthy(enemyMoveId) ? enemyMoveId : "?");
      self.emit({ kind: "message", text: Strings.get("%s's %s is DISABLED!",
        self.monName(self.enemy), moveName) });
      return;
    }
    self.useMove(self.enemy, self.player, enemyMoveId);
  };

  const residualHalf = (mon: any): boolean => {
    if (truthy(self.faintInterrupt) || truthy(self.forcedSwitch)) return true;
    // engine/battle/core.asm:1005
    self.tickStatus(mon);
    self.tickSeedAndCurse(mon);
    if (self.resolveFaints()) return true;
    return truthy(self.faintInterrupt);
  };

  // PlayerTurn_EndOpponentProtectEndureDestinyBond and its enemy twin
  // (core.asm): a side's own Destiny Bond ends as its turn starts
  // (EndUserDestinyBond), the other side's once that turn is done -- so the
  // bond covers exactly the opponent's next action.
  const playerTurn = (): void => {
    if (truthy(self.player)) self.volatile(self.player).destinyBond = undefined;
    playerAttack();
    if (truthy(self.enemy)) self.volatile(self.enemy).destinyBond = undefined;
  };
  const enemyTurn = (): void => {
    if (truthy(self.enemy)) self.volatile(self.enemy).destinyBond = undefined;
    enemyAttack();
    if (truthy(self.player)) self.volatile(self.player).destinyBond = undefined;
  };

  if (playerFirst) {
    playerTurn();
    // A wild Roar or Whirlwind ends the battle from THIS half of the turn the
    // same way a flee ends it from the other: `.wild_force_flee` writes DRAW
    // into wBattleResult and the turn loop's `.quit` takes the round with it.
    if (truthy(self.over)) return self.takeEvents();
    if (self.resolveFaints()) return self.takeEvents();
    // A faint ends the attack phase.  Battle_PlayerFirst reaches both faint
    // handlers with `jp`, not `call` (engine/battle/core.asm:871-874), so the
    // enemy's half of the round is never run.  The end-of-turn block below
    // still runs (HandleBetweenTurnEffects, core.asm:196).
    if (!residualHalf(self.player) && !truthy(self.over)
        && (self.player.hp ?? 0) > 0) {
      enemyTurn();
      if (truthy(self.over)) return self.takeEvents();
      if (self.resolveFaints()) return self.takeEvents();
      residualHalf(self.enemy);
    }
  } else {
    enemyTurn();
    // A flee ends the battle where it stands: the cart jumps straight to
    // WildFled_EnemyFled_LinkBattleCanceled and never reaches the player's
    // half of the turn or the residual damage.
    if (truthy(self.over)) return self.takeEvents();
    if (self.resolveFaints()) return self.takeEvents();
    // Same `jp` (core.asm:834-837): a mon that fainted to the enemy's move
    // takes the rest of the attack phase with it.
    if (!residualHalf(self.enemy) && !truthy(self.over)
        && (self.player.hp ?? 0) > 0) {
      playerTurn();
      if (truthy(self.over)) return self.takeEvents();
      if (self.resolveFaints()) return self.takeEvents();
      residualHalf(self.player);
    }
  }
  if (truthy(self.over)) return self.takeEvents();
  if (self.resolveFaints()) return self.takeEvents();
  self.faintInterrupt = undefined;

  // A successful Roar or Whirlwind ends the ROUND: the turn loop's `.quit`
  // on wForcedSwitch skips HandleBetweenTurnEffects, so nothing ticks on
  // the turn a mon was dragged out.
  if (truthy(self.forcedSwitch)) {
    self.forcedSwitch = undefined;
    return self.takeEvents();
  }

  let firstMon = self.player;
  let secondMon = self.enemy;
  if (truthy(self.mirrored)) { firstMon = self.enemy; secondMon = self.player; }
  self.tickWeather();
  self.tickWrap(firstMon);
  self.tickWrap(secondMon);
  self.tickHeldItem(firstMon);
  self.tickHeldItem(secondMon);
  self.tickFutureSight(firstMon);
  self.tickFutureSight(secondMon);
  self.tickPerish(firstMon);
  self.tickPerish(secondMon);
  self.tickScreens();
  self.tickCounters(firstMon);
  self.tickCounters(secondMon);
  self.resolveFaints();
  return self.takeEvents();
}

// Lua: Battle.lua:5395
function linkOff(v: unknown): boolean {
  return v == null || v === false || v === 0;
}

// Lua: Battle.lua:5399
function linkScalar(v: any): string {
  if (v !== null && typeof v === "object") {
    return tostring(truthy(v.id) ? v.id : (truthy(v.move) ? v.move : "?"));
  }
  if (typeof v === "boolean") return v ? "T" : "F";
  return tostring(v);
}

// Lua: Battle.lua:5405
function linkPp(mon: any): string {
  const out: string[] = [];
  for (const mv of ((truthy(mon) && truthy(mon.moves)) ? mon.moves : [])) {
    out.push(format("%s=%s", tostring(mv.id), tostring(mv.pp ?? 0)));
  }
  return out.join(",");
}

// Lua: Battle.lua:5413
function linkStages(self: any, key: string): string {
  const stages = (truthy(self.stages) && truthy(self.stages[key])) ? self.stages[key] : {};
  const out: string[] = [];
  for (const stat of Battle.LINK_STAGES) {
    out.push(tostring(stages[stat] ?? 0));
  }
  return out.join(",");
}

// Lua: Battle.lua:5422
function linkActive(self: any, mon: any, key: string): string {
  if (!truthy(mon)) return "-";
  return format("%s:%d:%s:%s:%s:%s", tostring(mon.species), mon.hp ?? 0,
    tostring(mon.status ?? false), linkStages(self, key), linkPp(mon),
    tostring(truthy(mon.item) ? mon.item : "-"));
}

// Lua: Battle.lua:5429
function linkVolatile(mon: any): string {
  if (!truthy(mon)) return "-";
  const state = mon.volatile ?? {};
  const out: string[] = [];
  for (const field of Battle.LINK_VOLATILE) {
    if (!linkOff(state[field])) {
      out.push(field + "=" + linkScalar(state[field]));
    }
  }
  if (!linkOff(mon.statusTurns)) {
    out.push("statusTurns=" + tostring(mon.statusTurns));
  }
  if (!linkOff(mon.toxicCounter)) {
    out.push("toxicCounter=" + tostring(mon.toxicCounter));
  }
  return out.join(",");
}

// Lua: Battle.lua:5447
function linkSide(self: any, key: string): string {
  const screens = (truthy(self.screens) && truthy(self.screens[key])) ? self.screens[key] : {};
  const out: string[] = [truthy((self.spikes ?? {})[key]) ? "spikes" : "-"];
  for (const field of Battle.LINK_SCREENS) {
    out.push(field + "=" + tostring(screens[field] ?? 0));
  }
  return out.join(",");
}

// Lua: Battle.lua:5456
function linkBench(party: any): string {
  const out: string[] = [];
  for (const mon of (party ?? [])) {
    out.push(format("%s:%d:%s:%s", tostring(mon.species), mon.hp ?? 0,
      tostring(mon.status ?? false), tostring(truthy(mon.item) ? mon.item : "-")));
  }
  return out.join("|");
}

// Lua: Battle.lua:5485-5486
Battle.Damage = Damage;
Battle.Mon = Mon;
export default Battle;
