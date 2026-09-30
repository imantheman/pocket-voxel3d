// Gen 2 trainer AI: a port of gen1recomp src/battle/gen2/Ai.lua (bdfac727, MIT).
//
// Gen 2 trainer AI (engine/battle/ai/scoring.asm + engine/battle/ai/move.asm).
//
// The cart scores every move the enemy knows, then picks the *lowest* score:
// each scoring layer walks the move list and either `dec [hl]` to encourage a
// move or `inc [hl]` to discourage it.  Which layers run is a per-class bit
// field, TRNATTR_AI_MOVE_WEIGHTS, which the extractor already carries on each
// trainer class record as `attributes` -- bytes 4 and 5, little-endian.
//
// A class with no flags (and every wild mon) simply picks at random, which is
// what AIChooseMove does when wEnemyTrainerAIFlags is zero.  That is also the
// honest fallback for a layer this file does not model: it never scores, so it
// never scores wrongly.
//
// Port notes: `attributes` is the importer's 0-based array, so the Lua's
// attributes[4]/[5] are [3]/[4] here (and [6]/[7] are [5]/[6]).  Lua's
// multiple returns are tuples: Ai.choose -> [moveId, scores],
// Ai.switchScore -> [weight, index].  Score tables are 0-based arrays.
// Lua truthiness on the open-shaped `st` state goes through truthy().

import { Damage } from "./Damage.ts";
import { mod, sortedKeys, truthy } from "../platform/lua.ts";

/** `random(n)` returning 0..n-1 (BattleRandom). */
export type ZeroRandom = (n: number) => number;

export interface SmartCtx {
  random: ZeroRandom;
  moveId?: string;
}

/** An AI_Smart per-effect handler: returns the score delta. */
export type SmartHandler = (
  ctx: SmartCtx,
  st: any,
  matchup?: number,
  damage?: number,
  playerLastPower?: number,
) => number;

export interface AiLayer {
  kind?: string;
  flag?: string;
  score: (view: any, def: any, score: number) => number | undefined;
  [k: string]: any;
}

const T = truthy;

// The type matchup a move would get, x10 (10 = neutral, 0 = immune).
// Lua: Ai.lua:94
function matchupOf(context: any, def: any, defender: any): number {
  const chart = context.typeChart ?? {};
  return Damage.typeMultiplier(def.type, defender.types ?? [], chart.matchups);
}

// A rough expected damage, used only to rank moves against each other: the
// real roll's randomness would make the AI's own choice non-deterministic,
// which is not what the cart does (AI_Aggressive compares wCurDamage from a
// no-random pass).
// Lua: Ai.lua:103
function expectedDamage(context: any, attacker: any, defender: any, def: any): number {
  if ((def.power ?? 0) <= 0) return 0;
  const [damage] = Damage.calc({
    level: attacker.level ?? 1,
    power: def.power,
    moveType: def.type,
    attacker: {
      attack: (attacker.stats ?? {}).attack,
      specialAttack: (attacker.stats ?? {}).specialAttack,
      types: attacker.types,
      stages: context.attackerStages,
    },
    defender: {
      defense: (defender.stats ?? {}).defense,
      specialDefense: (defender.stats ?? {}).specialDefense,
      types: defender.types,
      stages: context.defenderStages,
    },
    types: (context.typeChart ?? {}).types,
    matchups: (context.typeChart ?? {}).matchups,
    // AIDamageCalc runs BattleCommand_DamageCalc itself (scoring.asm:3002-3016),
    // so the enemy's estimate takes the `srl c` too (effect_commands.asm:2904-2909).
    defenseHalved: def.effect === "EFFECT_SELFDESTRUCT",
    critical: false,
    random: () => 0,
  });
  return damage;
}

//--------------------------------------------------------------------------
// AI_Smart (engine/battle/ai/scoring.asm)
//--------------------------------------------------------------------------
//
// The heaviest layer: a 70-entry table of per-EFFECT handlers, each one a few
// lines of "look at the HP, the speed and the statuses, then encourage or
// discourage".  `dec [hl]` encourages (a LOWER score wins) and `inc [hl]`
// discourages; AIDiscourageMove adds ten, which is what "dismiss" means.
//
// The handlers below are transcribed one for one.  An effect with no handler
// is simply not scored by this layer, which is exactly what the cart does with
// an effect that is not in its table.

// AIDiscourageMove.
const DISMISS = 10;

// The two coin flips the scoring layers use.  `cp 20 percent - 1` succeeds
// (carry set, meaning "return without scoring") on the LOW roll, so the
// helpers below read as "does the encouragement happen".
// Lua: Ai.lua:151
function chance(random: ZeroRandom, percent: number): boolean {
  return random(100) + 1 <= percent;
}

// state (all optional; a missing field simply never fires its branch):
//   enemyHp / enemyMaxHp / playerHp / playerMaxHp
//   enemyFaster            AICompareSpeed
//   enemyTurns / playerTurns  how many turns each mon has been out
//   playerStatus / enemyStatus
//   playerToxic, playerLeechSeed, playerCharged, playerFlying
//   enemyRage, enemyProtectCount, enemyFuryCutter
//   stages (the enemy's) / playerStages
//   knownEffects           the effects the enemy's own move list carries
//   enemyMoveIds           the move IDS the enemy knows (AIHasMoveInArray)
//   enemyTypes / playerTypes   both slots, IN ORDER: the weather and Curse
//                          handlers read slot 1 before slot 2 and a swapped
//                          pair scores differently
//   playerSpecialType      either player type is on the special side of
//                          constants/type_constants.asm (`cp SPECIAL`)
//   playerMatchupScore     CheckPlayerMoveTypeMatchups' wEnemyAISwitchScore
//   playerLastMovePp / playerLastMoveMatchup / playerLastMoveSpecial
//   playerSpecialMoves     the special twin of playerPhysicalMoves
//   playerUsedEffects      the EFFECTS behind wPlayerUsedMoves
//   playerFuryCutter / playerRollout   the player's own ramp
//   playerFlyingUp / playerUnderground SUBSTATUS_FLYING and _UNDERGROUND
//                          split apart, where playerFlying is the mask
//   playerLastMon          AICheckLastPlayerMon
//   enemyToxic, enemyLeechSeed, enemySpikes, enemyPartyStatus
//   enemyPerishCount, enemySleepTurns, enemyHasBench
//   enemyInaccurateEffectiveMove   AI_Smart_LockOn's `.checkmove` verdict,
//                          explicitly false when the loop found nothing
//   playerLockOn           SUBSTATUS_LOCK_ON on the player, which is the
//                          enemy's own Lock-On having landed (the cart sets
//                          the bit on the TARGET); it also drives
//                          Ai.lockOnPostPass
//   hiddenPowerPower / hiddenPowerMatchup   HiddenPowerDamage's d and matchup
//   weather                wBattleWeather, "sun" / "rain" / "sandstorm"
//
// These are read but never produced, because the port models no such
// volatile yet; their branches are dead until it does:
//   playerTrapped, playerInLove, playerIdentified, playerNightmare,
//   playerCursed, playerMinimized, enemyWrapped, conversion2Matchup
// Lua: Ai.lua:193
function fraction(value: any, max: any, part: number): boolean | undefined {
  if (!(T(value) && T(max) && max > 0)) return undefined;
  return value >= max * part;
}

/** `st.stages and st.stages[key] or 0` */
function stageOf(stages: any, key: string): number {
  return (T(stages) ? stages[key] : undefined) ?? 0;
}

const S: Record<string, SmartHandler> = {};

// Greatly encourage a sleep move when the enemy can follow it with Dream
// Eater or Nightmare; a coin flip otherwise.
// Lua: Ai.lua:203
S.EFFECT_SLEEP = (ctx, st) => {
  const combo = T(st.knownEffects) && (T(st.knownEffects.EFFECT_DREAM_EATER) || T(st.knownEffects.EFFECT_NIGHTMARE));
  if (!combo) return 0;
  if (!chance(ctx.random, 50)) return 0;
  return -2;
};

// Dream Eater: 90% chance to greatly encourage.  AI_Basic is what keeps it
// off an awake target.
// Lua: Ai.lua:213
S.EFFECT_DREAM_EATER = (ctx) => {
  if (chance(ctx.random, 10)) return 0;
  return -3;
};

// Absorb and friends: discouraged when resisted, encouraged when the enemy is
// hurt and the matchup is at least neutral.
// Lua: Ai.lua:220
S.EFFECT_LEECH_HIT = (ctx, st, matchup) => {
  if ((matchup ?? 10) < 10) {
    if (chance(ctx.random, 39)) return 0;
    return 1;
  }
  if ((matchup ?? 10) === 10) return 0;
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -1;
};

// Toxic and Leech Seed (AI_Smart_Toxic, which AI_Smart_LeechSeed shares):
// pointless once the target is already low, since the residual will not get
// the turns to matter.  AICheckPlayerHalfHP sets carry when the player is
// ABOVE half and the routine is `ret c`, so the discouragement lands BELOW
// half; S.EFFECT_OHKO reads the same idiom the same way.
// Lua: Ai.lua:236
const halfHpDiscourage: SmartHandler = (_ctx, st) => {
  if (fraction(st.playerHp, st.playerMaxHp, 0.5)) return 0;
  return 1;
};
S.EFFECT_TOXIC = halfHpDiscourage;
S.EFFECT_LEECH_SEED = halfHpDiscourage;

// Light Screen / Reflect: only worth it at full HP.
// Lua: Ai.lua:244
const fullHpOnly: SmartHandler = (ctx, st) => {
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) return 0;
  if (chance(ctx.random, 8)) return 0;
  return 1;
};
S.EFFECT_LIGHT_SCREEN = fullHpOnly;
S.EFFECT_REFLECT = fullHpOnly;

// Evasion up: dismissed at the cap, greatly encouraged at full HP (and
// especially against a badly poisoned target), discouraged when nearly dead.
// Lua: Ai.lua:254
S.EFFECT_EVASION_UP = (ctx, st) => {
  if (stageOf(st.stages, "evasion") >= 6) return DISMISS;
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) {
    if (T(st.playerToxic)) return -2;
    if (chance(ctx.random, 70)) return -2;
    return 0;
  }
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 3;
  if (chance(ctx.random, 4)) return -2;
  return 0;
};

// Swift and friends: worth it once accuracy or evasion has moved three stages.
// Lua: Ai.lua:267
S.EFFECT_ALWAYS_HIT = (ctx, st) => {
  const accDown = stageOf(st.stages, "accuracy") <= -3;
  const evaUp = stageOf(st.playerStages, "evasion") >= 3;
  if (!(accDown || evaUp)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -2;
};

// OHKO: dismissed against a higher-level target, discouraged once the target
// is below half.
// Lua: Ai.lua:277
S.EFFECT_OHKO = (_ctx, st) => {
  if ((st.playerLevel ?? 1) > (st.enemyLevel ?? 1)) return DISMISS;
  if (fraction(st.playerHp, st.playerMaxHp, 0.5)) return 0;
  return 1;
};

// Confusion: worth less the lower the target already is.
// Lua: Ai.lua:284
S.EFFECT_CONFUSE = (ctx, st) => {
  let score = 0;
  if (!fraction(st.playerHp, st.playerMaxHp, 0.5)) {
    if (!chance(ctx.random, 10)) score = score + 1;
    if (!fraction(st.playerHp, st.playerMaxHp, 0.25)) {
      score = score + 1;
    }
  }
  return score;
};

// Paralysis: greatly encouraged when the enemy is the SLOWER one, discouraged
// against a nearly-dead target.
// Lua: Ai.lua:297
S.EFFECT_PARALYZE = (ctx, st) => {
  if (!fraction(st.playerHp, st.playerMaxHp, 0.25)) {
    if (chance(ctx.random, 50)) return 0;
    return 1;
  }
  if (T(st.enemyFaster)) return 0;
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -2;
};

// Substitute: dismissed below half HP.
// Lua: Ai.lua:309
S.EFFECT_SUBSTITUTE = (_ctx, st) => {
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 0;
  return DISMISS;
};

// Hyper Beam: a finisher, not an opener.
// Lua: Ai.lua:315
S.EFFECT_HYPER_BEAM = (ctx, st) => {
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) {
    if (chance(ctx.random, 35)) return 0;
    let score = 1;
    if (!chance(ctx.random, 50)) score = score + 1;
    return score;
  }
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  if (chance(ctx.random, 50)) return 0;
  return -1;
};

// Reversal and Skull Bash both want the enemy nearly dead.
// Lua: Ai.lua:328
const needsLowHp: SmartHandler = (_ctx, st) => {
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  return 1;
};
S.EFFECT_REVERSAL = needsLowHp;
S.EFFECT_SKULL_BASH = needsLowHp;

// Belly Drum: full HP or nothing.
// Lua: Ai.lua:336
S.EFFECT_BELLY_DRUM = (_ctx, st) => {
  if (stageOf(st.stages, "attack") >= 3) return 5;
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) return 0;
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 1;
  return 5;
};

// Attract: an opener.
// Lua: Ai.lua:344
S.EFFECT_ATTRACT = (ctx, st) => {
  if ((st.playerTurns ?? 0) === 0) {
    if (chance(ctx.random, 79)) return -1;
    return 0;
  }
  if (chance(ctx.random, 20)) return 0;
  return 1;
};

// Quick Attack and friends: only when the enemy is already slower, dismissed
// against something off the field, encouraged when it would finish the job.
// Lua: Ai.lua:355
S.EFFECT_PRIORITY_HIT = (_ctx, st, _matchup, damage) => {
  if (T(st.enemyFaster)) return 0;
  if (T(st.playerFlying)) return DISMISS;
  if (T(damage) && T(st.playerHp) && damage! >= st.playerHp) return -1;
  return 0;
};

// Protect: never twice running, and worth it against a charging or poisoned
// target.
// Lua: Ai.lua:364
S.EFFECT_PROTECT = (_ctx, st) => {
  if ((st.enemyProtectCount ?? 0) > 0) return 2;
  if (T(st.playerLockOn)) return 1;
  if ((st.playerFuryCutter ?? 0) >= 3) return -1;
  if (T(st.playerCharged) || T(st.playerToxic) || T(st.playerLeechSeed)) return -1;
  return 0;
};

// Endure: for a Reversal follow-up, and never at high HP.
// Lua: Ai.lua:373
S.EFFECT_ENDURE = (ctx, st) => {
  if ((st.enemyProtectCount ?? 0) > 0) return 2;
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) return 2;
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 1;
  if (T(st.knownEffects) && T(st.knownEffects.EFFECT_REVERSAL)) {
    if (chance(ctx.random, 20)) return 0;
    return -3;
  }
  return 0;
};

// Rollout and Fury Cutter: the ramp is only worth starting when nothing is
// going to interrupt it.
// Lua: Ai.lua:386
const rollout: SmartHandler = (ctx, st) => {
  const risky =
    st.enemyStatus === "paralyze" ||
    T(st.enemyConfused) ||
    T(st.enemyInLove) ||
    !fraction(st.enemyHp, st.enemyMaxHp, 0.25) ||
    stageOf(st.stages, "accuracy") < 0 ||
    stageOf(st.playerStages, "evasion") >= 1;
  if (!risky) return 0;
  if (chance(ctx.random, 20)) return 0;
  return 1;
};
S.EFFECT_ROLLOUT = rollout;

// Fury Cutter adds its own ramp bonus and then falls through to Rollout's
// check, which is literally what the ASM does.
// Lua: Ai.lua:400
S.EFFECT_FURY_CUTTER = (ctx, st) => {
  const count = st.enemyFuryCutterCount ?? 0;
  let score = 0;
  if (count >= 1) score = score - 1;
  if (count >= 2) score = score - 2;
  if (count >= 3) score = score - 3;
  return score + rollout(ctx, st);
};

// Rage: worth continuing once it is building.
// Lua: Ai.lua:410
S.EFFECT_RAGE = (ctx, st) => {
  if (!T(st.enemyRage)) return 0;
  if (chance(ctx.random, 50)) return -1;
  return -1 - Math.min(3, st.enemyRageCount ?? 0);
};

// Encore: only from ahead, and only against a weak or resisted move.
// Lua: Ai.lua:417
S.EFFECT_ENCORE = (_ctx, st, _matchup, _damage, playerLastPower) => {
  if (!T(st.enemyFaster)) return 1;
  if (!T(st.playerLastMove)) return DISMISS;
  if ((playerLastPower ?? 0) === 0) return -1;
  return 0;
};

// Counter: worth it when the player's known moves are mostly physical.
// Lua: Ai.lua:425
S.EFFECT_COUNTER = (_ctx, st) => {
  if ((st.playerPhysicalMoves ?? 0) === 0) return 1;
  return -1;
};

//--------------------------------------------------------------------------
// The rest of AI_Smart_EffectHandlers, in the jumptable's own order.
//--------------------------------------------------------------------------
//
// Several entries in the table point at ONE cart body carrying two or more
// labels; those share a local here rather than being copied, and the
// comment names every label that sits on it.  Where a shared body is reached
// by an ASM fallthrough (`.greatly_discourage` dropping into `.discourage`)
// the two deltas are added together into a single return, because the cart
// really does run both.

// Selfdestruct and Explosion (AI_Smart_Selfdestruct): a last resort.  Greatly
// discouraged above half HP, left alone at or below a quarter (nothing left to
// lose), and greatly discouraged 92% of the time in between.  `.discourage` is
// reached from both ends, which is why the same +3 appears twice.
// Lua: Ai.lua:445
S.EFFECT_SELFDESTRUCT = (ctx, st) => {
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 3;
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  if (chance(ctx.random, 8)) return 0;
  return 3;
};

// data/battle/ai/useful_moves.asm: the nineteen moves AI_Smart_MirrorMove,
// AI_Smart_Mimic and AI_Smart_Disable test the player's last move against.
// The keys are the cache's own move ids, so PSYCHIC is PSYCHIC_M.
// Lua: Ai.lua:455
const USEFUL_MOVES: Record<string, boolean> = {
  DOUBLE_EDGE: true, SING: true, FLAMETHROWER: true, HYDRO_PUMP: true,
  SURF: true, ICE_BEAM: true, BLIZZARD: true, HYPER_BEAM: true,
  SLEEP_POWDER: true, THUNDERBOLT: true, THUNDER: true, EARTHQUAKE: true,
  TOXIC: true, PSYCHIC_M: true, HYPNOSIS: true, RECOVER: true,
  FIRE_BLAST: true, SOFTBOILED: true, SUPER_FANG: true,
};

function useful(moveId: any): boolean {
  return moveId != null && USEFUL_MOVES[moveId] === true;
}

// Mirror Move (AI_Smart_MirrorMove).  With nothing to copy it is dismissed
// only when the enemy is FASTER, because a faster enemy moves before the
// player and would copy nothing; from behind the player will have moved by
// then, so the cart says nothing.  With a useful move on the table it is a
// coin flip to encourage, and a faster enemy encourages again.
// Lua: Ai.lua:468
S.EFFECT_MIRROR_MOVE = (ctx, st) => {
  if (!T(st.playerLastMove)) {
    if (!T(st.enemyFaster)) return 0;
    return DISMISS;
  }
  if (!useful(st.playerLastMove)) return 0;
  if (chance(ctx.random, 50)) return 0;
  if (!T(st.enemyFaster)) return -1;
  if (chance(ctx.random, 10)) return -1;
  return -2;
};

// Sand-Attack and friends (AI_Smart_AccuracyDown).  The HP block picks one
// bonus: a full-health player facing a healthy enemy is a big encouragement, a
// nearly dead player a big discouragement.  The tail then re-reads the board
// (badly poisoned, seeded, accuracy already under the enemy's evasion, mid
// ramp) and can cancel it, which the cart's own comments admit to.
// Lua: Ai.lua:485
S.EFFECT_ACCURACY_DOWN = (ctx, st) => {
  let score = 0;
  if (fraction(st.playerHp, st.playerMaxHp, 1) && fraction(st.enemyHp, st.enemyMaxHp, 0.5)) {
    if (T(st.playerToxic)) return -2;
    if (chance(ctx.random, 70)) return -2;
  } else if (!fraction(st.playerHp, st.playerMaxHp, 0.25)) {
    score = 2;
  } else if (chance(ctx.random, 4)) {
    return -2;
  } else if (fraction(st.playerHp, st.playerMaxHp, 0.5)) {
    if (chance(ctx.random, 20)) return -2;
  } else if (!chance(ctx.random, 50)) {
    // `.hp_mismatch_3`'s 50% miss falls THROUGH into `.hp_mismatch_2`, so the
    // move is at +2 before the tail below ever runs.
    score = 2;
  }
  // .not_encouraged, which `.hp_mismatch_2` also falls into: a move already at
  // +2 can still be pulled back down here.
  if (T(st.playerToxic)) {
    if (chance(ctx.random, 31)) return score;
    return score - 2;
  }
  if (T(st.playerLeechSeed)) {
    if (chance(ctx.random, 50)) return score;
    return score - 1;
  }
  const enemyEva = stageOf(st.stages, "evasion");
  const playerAcc = stageOf(st.playerStages, "accuracy");
  if (playerAcc < enemyEva) return score + 1;
  if ((st.playerFuryCutter ?? 0) > 0) return score - 2;
  if (T(st.playerRollout)) return score - 2;
  return score + 1;
};

// wPlayerStatLevels / wEnemyStatLevels order, in Battle.newStages' names.
// AI_Smart_ResetStats' loop counter is NUM_LEVEL_STATS (8) but it decrements
// BEFORE every read, so it walks these seven and stops short of the ABILITY
// pseudo-stat BattleCommand_Curse uses.
// Lua: Ai.lua:524
const STAGE_KEYS = ["attack", "defense", "speed", "specialAttack", "specialDefense", "accuracy", "evasion"];

// Haze (AI_Smart_ResetStats): worth it once the board has turned, meaning any
// of the enemy's own stages sits at -3 or worse or any of the player's at +3 or
// better.  84% to encourage then, a flat discouragement when neither is true.
// The cart bails out of the enemy loop the moment it finds a low stage and only
// then walks the player's, which is the same answer as one combined pass.
// Lua: Ai.lua:532
S.EFFECT_RESET_STATS = (ctx, st) => {
  let worth = false;
  for (const key of STAGE_KEYS) {
    if (stageOf(st.stages, key) <= -3) worth = true;
    if (stageOf(st.playerStages, key) >= 3) worth = true;
  }
  if (!worth) return 1;
  if (chance(ctx.random, 16)) return 0;
  return -1;
};

// Bide (AI_Smart_Bide): full HP or nothing.  The same shape as Light Screen's
// check, but the cart rolls 10% here where fullHpOnly rolls 8%, so the two
// cannot share a body.
// Lua: Ai.lua:546
S.EFFECT_BIDE = (ctx, st) => {
  if (fraction(st.enemyHp, st.enemyMaxHp, 1)) return 0;
  if (chance(ctx.random, 10)) return 0;
  return 1;
};

// Whirlwind and Roar (AI_Smart_ForceSwitch), which AI_Smart_BatonPass repeats
// instruction for instruction: only worth blowing the player away once it HAS
// shown a super-effective move, which CheckPlayerMoveTypeMatchups reports as a
// switch score below BASE_AI_SWITCH_SCORE.
// Lua: Ai.lua:556
const switchMatchup: SmartHandler = (_ctx, st) => {
  const score = st.playerMatchupScore;
  if (score == null) return 0;
  if (score < Ai.BASE_SWITCH_SCORE) return 0;
  return 1;
};
S.EFFECT_FORCE_SWITCH = switchMatchup;

// Recover, Rest, Softboiled (AI_Smart_Heal): 90% to greatly encourage below a
// quarter HP, discouraged above half, nothing in between.  AI_Smart_MorningSun,
// AI_Smart_Synthesis and AI_Smart_Moonlight are three more labels on this one
// body, so all four effects share it.
// Lua: Ai.lua:568
const healSelf: SmartHandler = (ctx, st) => {
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) {
    if (chance(ctx.random, 10)) return 0;
    return -2;
  }
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 0;
  return 1;
};
S.EFFECT_HEAL = healSelf;

// Razor Wind (AI_Smart_RazorWind, shared with AI_Smart_Unused2B).  A two turn
// move, so the cart drops it while a Perish count is running out, hits it with
// a flat +6 (deliberately NOT AIDiscourageMove's ten) if the player has ever
// shown Protect, and discourages it four times in five while the enemy is
// confused or at or below half HP.  The confused case falls straight into the
// 79% roll without ever testing HP.
// Lua: Ai.lua:584
const razorWind: SmartHandler = (ctx, st) => {
  if (T(st.enemyPerishCount) && st.enemyPerishCount < 3) return 1;
  if (T(st.playerUsedEffects) && T(st.playerUsedEffects.EFFECT_PROTECT)) {
    return 6;
  }
  if (!T(st.enemyConfused)) {
    if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 0;
  }
  if (chance(ctx.random, 79)) return 0;
  return 1;
};
S.EFFECT_RAZOR_WIND = razorWind;

// Super Fang (AI_Smart_SuperFang) halves what is left, so the only thing the
// cart checks is whether there is enough left to halve.
// Lua: Ai.lua:599
S.EFFECT_SUPER_FANG = (_ctx, st) => {
  if (fraction(st.playerHp, st.playerMaxHp, 0.25)) return 0;
  return 1;
};

// Bind, Wrap, Fire Spin, Clamp (AI_Smart_TrapTarget): half the time greatly
// encouraged against a target that is already suffering (badly poisoned, in
// love, identified, mid Rollout, having a Nightmare) or still on its first
// turn, and half the time discouraged otherwise or while the trap is already
// running.  The encourage side also wants the enemy above a quarter HP to
// survive the lock.
// Lua: Ai.lua:610
S.EFFECT_TRAP_TARGET = (ctx, st) => {
  let encourage = false;
  if (!T(st.playerTrapped)) {
    encourage =
      T(st.playerToxic) ||
      T(st.playerInLove) ||
      T(st.playerRollout) ||
      T(st.playerIdentified) ||
      T(st.playerNightmare) ||
      (st.playerTurns ?? 0) === 0;
  }
  if (!encourage) {
    if (chance(ctx.random, 50)) return 0;
    return 1;
  }
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  if (chance(ctx.random, 50)) return 0;
  return -2;
};

// AI_Smart_Unused2B is the second label on AI_Smart_RazorWind's body.
S.EFFECT_UNUSED_2B = razorWind;

// Amnesia (AI_Smart_SpDefenseUp2): discouraged below half HP or once Sp.Def is
// already at +4, ignored from +2 up, and 80% to greatly encourage below that
// when the player carries a special type.  The cart reuses the value already in
// `a` for the second compare, so the +2 gate reads the same Sp.Def stage it
// just tested against +4.
// Lua: Ai.lua:634
S.EFFECT_SP_DEF_UP_2 = (ctx, st) => {
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 1;
  const stage = stageOf(st.stages, "specialDefense");
  if (stage >= 4) return 1;
  if (stage >= 2) return 0;
  if (!T(st.playerSpecialType)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -2;
};

// Icy Wind, and ONLY Icy Wind (AI_Smart_SpeedDownHit): the cart gates on
// wEnemyMoveStruct + MOVE_ANIM, so Bubble, Bubblebeam and Constrict share the
// effect but never reach the body.  Almost 90% to greatly encourage on the
// player's first turn, while the player is the faster one and the enemy is
// still above a quarter HP.
// Lua: Ai.lua:649
S.EFFECT_SPEED_DOWN_HIT = (ctx, st) => {
  if (ctx.moveId !== "ICY_WIND") return 0;
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 0;
  if ((st.playerTurns ?? 0) !== 0) return 0;
  if (T(st.enemyFaster)) return 0;
  if (chance(ctx.random, 12)) return 0;
  return -2;
};

// Mimic (AI_Smart_Mimic): with nothing to copy it is dismissed from ahead and
// merely discouraged from behind, because `.dismiss` falls through into
// `.discourage`.  Otherwise it wants the enemy above half HP and a copied move
// that is at least neutral coming back at its owner: the cart sets hBattleTurn
// to 1, so BattleCheckTypeMatchup defends with the PLAYER's types.
// Lua: Ai.lua:663
S.EFFECT_MIMIC = (ctx, st) => {
  if (!T(st.playerLastMove)) {
    if (T(st.enemyFaster)) return DISMISS;
    return 1;
  }
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 1;
  const copied = st.playerLastMoveMatchup;
  if (copied == null) return 0;
  if (copied < 10) return 1;
  let score = 0;
  if (copied > 10 && !chance(ctx.random, 50)) score = -1;
  if (!useful(st.playerLastMove)) return score;
  if (chance(ctx.random, 50)) return score;
  return score - 1;
};

// AI_Smart_Disable.  Only worth it from ahead: the slower enemy skips straight
// to the discourage.  From ahead, a 61% encourage when the player's last move
// is one of UsefulMoves.  The "does my own move have power" test on the way out
// reads wEnemyMoveStruct + MOVE_POWER, which is 0 for every stock
// EFFECT_DISABLE move, so on an unmodded cart a boring last move always falls
// through into `.discourage`; the `damage` argument stands in for it so a
// modded Disable with real power keeps the branch.
// Lua: Ai.lua:686
S.EFFECT_DISABLE = (ctx, st, _matchup, damage) => {
  if (T(st.enemyFaster)) {
    if (useful(st.playerLastMove)) {
      if (chance(ctx.random, 39)) return 0;
      return -1;
    }
    if ((damage ?? 0) > 0) return 0;
  }
  if (chance(ctx.random, 8)) return 0;
  return 1;
};

// AI_Smart_PainSplit: discourage while doubling the enemy's HP would still
// overshoot the player's, since the split would then hand HP away.  The cart
// does this as one 16 bit compare of [player HP] against [enemy HP * 2]; its
// own comment states the test backwards.
// Lua: Ai.lua:702
S.EFFECT_PAIN_SPLIT = (_ctx, st) => {
  if (!(T(st.enemyHp) && T(st.playerHp))) return 0;
  if (st.playerHp >= st.enemyHp * 2) return 0;
  return 1;
};

// AI_Smart_Snore, shared verbatim with AI_Smart_SleepTalk (one label falls
// into the other).  The cart tests the sleep counter against 1, so it
// discourages only on the last sleeping turn and greatly encourages everything
// else, an AWAKE enemy included; AI_Redundant is what keeps these off an awake
// mon.
// Lua: Ai.lua:713
const snoreOrSleepTalk: SmartHandler = (_ctx, st) => {
  const count = st.enemySleepTurns;
  if (count == null) return 0;
  if (count === 1) return 3;
  return -3;
};
S.EFFECT_SNORE = snoreOrSleepTalk;

// AI_Smart_Conversion2.  CART BUG (docs/bugs_and_glitches.md): the guard reads
// `ld a, [wLastPlayerMove] / and a / jr nz, .discourage`, so it discourages
// once the player HAS moved and takes the matchup path only on turn one, where
// the move index it looks up is 0 - 1 = $ff, past the end of Moves.  The
// inverted test is kept; the garbage read becomes st.conversion2Matchup, which
// the port leaves nil so that path scores nothing.
// Lua: Ai.lua:727
S.EFFECT_CONVERSION2 = (ctx, st) => {
  if (!T(st.playerLastMove)) {
    const matchup = st.conversion2Matchup;
    if (matchup != null) {
      if (matchup > 10) {
        if (chance(ctx.random, 50)) return 0;
        return -1;
      }
      if (matchup === 10) return 0;
    } else {
      return 0;
    }
  }
  // .discourage
  if (chance(ctx.random, 10)) return 0;
  return 1;
};

// AI_Smart_LockOn.  Pointless when the player is already locked on, worthless
// when nearly dead, and only from ahead once past half HP.  It then wants a
// reason: the player's evasion up three, the enemy's accuracy down three, or
// failing both, at least one shaky-but-effective move to aim.
// The dismissal is only half of `.player_locked_on`: the branch also walks the
// enemy's OWN move list and encourages every shaky move by two, which is a
// score edit on OTHER moves and so cannot live in a per-move handler.  That
// half is Ai.lockOnPostPass, run from Ai.choose once the table is done.
// Lua: Ai.lua:753
S.EFFECT_LOCK_ON = (ctx, st) => {
  if (T(st.playerLockOn)) return DISMISS;
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return 1;
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5) && !T(st.enemyFaster)) {
    return 1;
  }
  const evasion = stageOf(st.playerStages, "evasion");
  if (evasion >= 3) {
    if (chance(ctx.random, 50)) return 0;
    return -2;
  }
  if (evasion >= 1) return 0;
  const accuracy = stageOf(st.stages, "accuracy");
  if (accuracy <= -3) {
    if (chance(ctx.random, 50)) return 0;
    return -2;
  }
  if (accuracy < 0) return 0;
  // .checkmove: the loop reaches .discourage only when no move qualified.
  if (st.enemyInaccurateEffectiveMove === false) return 1;
  return 0;
};

// AI_Smart_DefrostOpponent.  Dead twice over, and both are kept: no move
// carries EFFECT_DEFROST_OPPONENT (the cart says so itself), and the status it
// reads is wEnemyMonStatus, the AI's OWN freeze, not the opponent the effect
// names.
// Lua: Ai.lua:814
S.EFFECT_DEFROST_OPPONENT = (_ctx, st) => {
  if (st.enemyStatus !== "freeze") return 0;
  return -3;
};

// AI_Smart_SleepTalk is the same label body as AI_Smart_Snore.
S.EFFECT_SLEEP_TALK = snoreOrSleepTalk;

// AI_Smart_DestinyBond is the third label on the body `needsLowHp` already
// carries for AI_Smart_Reversal and AI_Smart_SkullBash.
S.EFFECT_DESTINY_BOND = needsLowHp;

// AI_Smart_Spite.  With nothing to drain yet it is a stall move: dismissed
// from ahead, half discouraged from behind.  Once the player has shown a move
// it goes by that move's remaining PP: under 6 is worth taking, 15 or more is
// not.  The cart reads the raw PP byte without masking off the PP Up bits, so
// a move with any PP Ups always lands on `.discourage`; the port stores plain
// PP and has no such bits to mask, so that quirk cannot be reproduced.
// Lua: Ai.lua:832
S.EFFECT_SPITE = (ctx, st) => {
  if (!T(st.playerLastMove)) {
    if (T(st.enemyFaster)) return DISMISS;
    if (chance(ctx.random, 50)) return 0;
    return 1;
  }
  // `.moveloop` falls out with no score when that move is not in the player's
  // current move list, which is what a nil PP stands in for here.
  const pp = st.playerLastMovePp;
  if (pp == null) return 0;
  if (pp < 6) {
    if (chance(ctx.random, 39)) return 0;
    return -2;
  }
  if (pp >= 15) return 1;
  if (!chance(ctx.random, 39)) return 0;
  return 1;
};

// AI_Smart_HealBell.  The cart ORs the status byte of every unfainted mon in
// wOTParty: nothing statused and a clean active mon dismisses the move.
// Otherwise one step of encouragement for the active mon being statused, and a
// coin flip for two more when that status is sleep or freeze, the two it cannot
// simply wait out.  `.ok` is reached both by the `jr z` and by falling through
// the `dec [hl]`, so the bonus stacks on top of the first step.
// Lua: Ai.lua:857
S.EFFECT_HEAL_BELL = (ctx, st) => {
  if (st.enemyPartyStatus == null) return 0;
  if (!T(st.enemyPartyStatus)) {
    // .no_status: the party copy can lag the active mon, which is the only way
    // this test and the one above disagree.
    if (T(st.enemyStatus)) return 0;
    return DISMISS;
  }
  let score = 0;
  if (T(st.enemyStatus)) score = score - 1;
  if (st.enemyStatus === "sleep" || st.enemyStatus === "freeze") {
    if (chance(ctx.random, 50)) return score;
    score = score - 2;
  }
  return score;
};

// AI_Smart_Thief: `ld a, [hl] / add $1e`.  Three times a dismissal, so Thief is
// only ever picked when nothing else is left.
// Lua: Ai.lua:876
S.EFFECT_THIEF = () => {
  return 30;
};

// AI_Smart_MeanLook.  Needs the enemy above half HP and the player holding
// something in reserve (trapping the player's last mon is dismissed outright).
// 80% to greatly encourage against a player who is already suffering, else
// discourage unless CheckPlayerMoveTypeMatchups says the player has nothing
// effective to answer with.
// CART BUG (docs/bugs_and_glitches.md): the badly-poisoned test reads
// wEnemySubStatus5, so the AI encourages Mean Look when IT is the poisoned one.
// Lua: Ai.lua:887
S.EFFECT_MEAN_LOOK = (ctx, st) => {
  let encourage = false;
  if (fraction(st.enemyHp, st.enemyMaxHp, 0.5)) {
    if (T(st.playerLastMon)) return DISMISS;
    if (T(st.enemyToxic)) {
      encourage = true;
    } else if (T(st.playerInLove) || T(st.playerRollout) || T(st.playerIdentified) || T(st.playerNightmare)) {
      encourage = true;
    } else if ((st.playerMatchupScore ?? Ai.BASE_SWITCH_SCORE) >= Ai.BASE_SWITCH_SCORE + 1) {
      return 0;
    }
  }
  if (!encourage) return 1;
  if (chance(ctx.random, 20)) return 0;
  return -3;
};

// AI_Smart_Nightmare: a flat coin flip.  AI_Basic is what keeps it off a
// target that is not asleep.
// Lua: Ai.lua:908
S.EFFECT_NIGHTMARE = (ctx) => {
  if (chance(ctx.random, 50)) return 0;
  return -1;
};

// AI_Smart_FlameWheel: five steps of encouragement when the enemy is frozen,
// because Flame Wheel and Sacred Fire thaw their own user in Gen 2.  Its status
// read really is the enemy's own, unlike AI_Smart_DefrostOpponent's.
// Lua: Ai.lua:916
S.EFFECT_FLAME_WHEEL = (_ctx, st) => {
  if (st.enemyStatus !== "freeze") return 0;
  return -5;
};

// Curse (AI_Smart_Curse).  A Ghost type enemy pays half its HP for a residual,
// so that half of the routine wants a healthy enemy, an uncursed target and the
// target's very first turn; the non-Ghost half is an Attack boost and wants a
// target it can actually punch, meaning neither of its types is special.
// Lua: Ai.lua:925
S.EFFECT_CURSE = (ctx, st) => {
  const enemyTypes: any[] = st.enemyTypes ?? [];
  const playerTypes: any[] = st.playerTypes ?? [];
  if (enemyTypes[0] === "GHOST" || enemyTypes[1] === "GHOST") {
    // .ghost_curse: dismissed at or below 25% (the cut would be suicide), and
    // discouraged at or below 50%.
    if (!fraction(st.enemyHp, st.enemyMaxHp, 0.25)) return DISMISS;
    if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 1;
    if (T(st.playerCursed)) return DISMISS;
    if ((st.playerTurns ?? 0) > 0) return 0;
    if (chance(ctx.random, 50)) return 0;
    return -2;
  }
  if (!fraction(st.enemyHp, st.enemyMaxHp, 0.5)) return 1;
  // wEnemyAtkLevel against BASE_STAT_LEVEL + 4 and + 2: at +4 the boost is
  // discouraged outright, at +2 the AI simply has no opinion left.
  const attack = stageOf(st.stages, "attack");
  if (attack >= 4) return 1;
  if (attack >= 2) return 0;
  // `cp GHOST` comes before `cp SPECIAL`, and `.greatly_discourage` falls
  // THROUGH into `.discourage`, so a Ghost FIRST type is +2, not +1.
  if (playerTypes[0] === "GHOST") return 2;
  if (T(st.playerSpecialType)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -2;
};

// Foresight (AI_Smart_Foresight).  Worth 61% encouragement when the accuracy
// war has already been lost (enemy accuracy at -3, player evasion at +3) or
// when the target is a Ghost the enemy's Normal and Fighting moves cannot
// touch; a flat 92% discouragement otherwise.
// Lua: Ai.lua:956
S.EFFECT_FORESIGHT = (ctx, st) => {
  const playerTypes: any[] = st.playerTypes ?? [];
  const encourage =
    stageOf(st.stages, "accuracy") <= -3 ||
    stageOf(st.playerStages, "evasion") >= 3 ||
    playerTypes[0] === "GHOST" ||
    playerTypes[1] === "GHOST";
  if (!encourage) {
    if (chance(ctx.random, 8)) return 0;
    return 1;
  }
  if (chance(ctx.random, 39)) return 0;
  return -2;
};

// Perish Song (AI_Smart_PerishSong).  FindAliveEnemyMons first: with nothing on
// the bench the countdown kills the enemy too, which is worth five points of
// discouragement.  A trapped player cannot run from it, so that is the one case
// the cart encourages; otherwise it is only left alone while the AI is losing
// the matchup and would rather rotate out anyway.
// Lua: Ai.lua:974
S.EFFECT_PERISH_SONG = (ctx, st) => {
  if (st.enemyHasBench === false) return 5;
  if (T(st.playerTrapped)) {
    if (chance(ctx.random, 50)) return 0;
    return -1;
  }
  const score = st.playerMatchupScore ?? Ai.BASE_SWITCH_SCORE;
  if (score < Ai.BASE_SWITCH_SCORE) return 0;
  if (chance(ctx.random, 50)) return 0;
  return 1;
};

// AI_Smart_Sandstorm's own .SandstormImmuneTypes, walked with IsInArray once
// per type slot.
// Lua: Ai.lua:988
const SANDSTORM_IMMUNE: Record<string, boolean> = { ROCK: true, GROUND: true, STEEL: true };

// Sandstorm (AI_Smart_Sandstorm).  Greatly discouraged against anything that
// shrugs the chip off (`.greatly_discourage` falls through into `.discourage`,
// hence +2), discouraged once the target is at or below half (the chip will not
// decide the fight any more), a coin flip otherwise.
// Lua: Ai.lua:994
S.EFFECT_SANDSTORM = (ctx, st) => {
  const playerTypes: any[] = st.playerTypes ?? [];
  if (SANDSTORM_IMMUNE[playerTypes[0] ?? ""] || SANDSTORM_IMMUNE[playerTypes[1] ?? ""]) {
    return 2;
  }
  if (!fraction(st.playerHp, st.playerMaxHp, 0.5)) return 1;
  if (chance(ctx.random, 50)) return 0;
  return -1;
};

// Swagger (AI_Smart_Swagger) jumps straight into AI_Smart_Attract: both are
// openers, 80% encouraged on the target's first turn and 80% discouraged after.
S.EFFECT_SWAGGER = S.EFFECT_ATTRACT;

// Safeguard (AI_Smart_Safeguard).  80% discouraged once the PLAYER is at or
// below half HP: the cart reads the player's bar, not the enemy's, on the
// theory that a nearly dead target is not going to status anything.
// AICheckPlayerHalfHP sets carry when the player is ABOVE half and the routine
// is `ret c`, so this layer only ever discourages.
// Lua: Ai.lua:1014
S.EFFECT_SAFEGUARD = (ctx, st) => {
  if (fraction(st.playerHp, st.playerMaxHp, 0.5)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return 1;
};

// Magnitude (AI_Smart_Magnitude), which AI_Smart_Earthquake shares outright.
// It only ever fires when the player's last move was Dig: greatly encouraged if
// the player is underground right now and the enemy moves first, and a coin
// flip when the player has surfaced but the enemy is SLOWER, which is the
// cart's guess that the player is about to dig again.  The two speed tests are
// opposite senses of the same AICompareSpeed carry.
// Lua: Ai.lua:1026
const smartEarthquake: SmartHandler = (ctx, st) => {
  if (st.playerLastMove !== "DIG") return 0;
  if (T(st.playerUnderground)) {
    if (!T(st.enemyFaster)) return 0;
    return -2;
  }
  // .could_dig
  if (T(st.enemyFaster)) return 0;
  if (chance(ctx.random, 50)) return 0;
  return -1;
};
S.EFFECT_MAGNITUDE = smartEarthquake;

// Baton Pass (AI_Smart_BatonPass) is AI_Smart_ForceSwitch's body again: the
// cart never looks at what the enemy would actually be passing.
S.EFFECT_BATON_PASS = switchMatchup;

// Pursuit (AI_Smart_Pursuit).  50% chance to greatly encourage it once the
// target is at or below 25% and likely to run or rotate; 80% discouraged
// otherwise, since at full HP it is just a 40 power Dark move.
// Lua: Ai.lua:1046
S.EFFECT_PURSUIT = (ctx, st) => {
  if (!fraction(st.playerHp, st.playerMaxHp, 0.25)) {
    if (chance(ctx.random, 50)) return 0;
    return -2;
  }
  if (chance(ctx.random, 20)) return 0;
  return 1;
};

// Rapid Spin (AI_Smart_RapidSpin).  80% chance to greatly encourage it when it
// would actually clear something off the ENEMY's own side: a Bind style trap,
// Leech Seed, or Spikes.  No opinion at all otherwise.
// Lua: Ai.lua:1058
S.EFFECT_RAPID_SPIN = (ctx, st) => {
  if (!(T(st.enemyWrapped) || T(st.enemyLeechSeed) || T(st.enemySpikes))) {
    return 0;
  }
  if (chance(ctx.random, 20)) return 0;
  return -2;
};

// AI_Smart_MorningSun, AI_Smart_Synthesis and AI_Smart_Moonlight are three more
// labels on AI_Smart_Heal's body.  The cart makes no weather check at all here,
// even though the three moves heal different fractions by weather.
S.EFFECT_MORNING_SUN = healSelf;
S.EFFECT_SYNTHESIS = healSelf;
S.EFFECT_MOONLIGHT = healSelf;

// Hidden Power (AI_Smart_HiddenPower): the cart throws away the Normal-type
// stub in the move table and recomputes the move's real type and base power
// from the enemy's DVs (HiddenPowerDamage), then scores THAT.  Resisted, or
// under 50 power, is discouraged; super effective, or a full 70 power at
// neutral, is encouraged.  The `matchup` argument the layer passes in is
// deliberately unused: it is the declared type's, which is what the cart
// discards.
// Lua: Ai.lua:1080
S.EFFECT_HIDDEN_POWER = (_ctx, st) => {
  const power = st.hiddenPowerPower;
  const matchup = st.hiddenPowerMatchup;
  if (!(T(power) && T(matchup))) return 0;
  // cp EFFECTIVE: not very effective, or immune, is `.bad`.
  if (matchup < 10) return 1;
  if (power < 50) return 1;
  // cp EFFECTIVE + 1: super effective is `.good` whatever the power is.
  if (matchup > 10) return -1;
  if (power < 70) return 0;
  return -1;
};

// Rain Dance and Sunny Day share AI_Smart_WeatherMove and its two tails,
// AIBadWeatherType (three inc [hl]) and AIGoodWeatherType (two dec [hl]).
// The player's type slots are read IN ORDER, bad then good per slot, so a
// Fire/Water target reads as "good" for Rain Dance where a Water/Fire one reads
// as "bad": that ordering is load bearing, do not fold it into a set.
// Lua: Ai.lua:1097
function weatherTypeVerdict(types: any[] | undefined, badType: string, goodType: string): string | undefined {
  for (let i = 0; i < 2; i++) {
    const slot = (types ?? [])[i];
    if (slot === badType) return "bad";
    if (slot === goodType) return "good";
  }
  return undefined;
}

// AIBadWeatherType.
const BAD_WEATHER = 3;

// AIGoodWeatherType: the weather would disfavour the player type-wise, so set
// it up while the player is still above half, and only while one of the two
// mons is still on its first turn.
// Lua: Ai.lua:1112
const goodWeatherType: SmartHandler = (_ctx, st) => {
  if (!fraction(st.playerHp, st.playerMaxHp, 0.5)) return 0;
  if ((st.playerTurns ?? 0) === 0) return -2;
  if ((st.enemyTurns ?? 0) !== 0) return 0;
  return -2;
};

// AI_Smart_WeatherMove: greatly discouraged unless the enemy actually knows a
// move off the matching list, and again once the player is at or below half; a
// coin flip encourages it otherwise.
// Lua: Ai.lua:1122
function weatherMove(ctx: SmartCtx, st: any, moves: string[]): number {
  if (!T(st.enemyMoveIds)) return 0;
  let hasOne = false;
  for (const id of moves) {
    if (T(st.enemyMoveIds[id])) {
      hasOne = true;
      break;
    }
  }
  if (!hasOne) return BAD_WEATHER;
  if (!fraction(st.playerHp, st.playerMaxHp, 0.5)) return BAD_WEATHER;
  if (chance(ctx.random, 50)) return 0;
  return -1;
}

// data/battle/ai/rain_dance_moves.asm, in list order.
// Lua: Ai.lua:1135
const RAIN_DANCE_MOVES = [
  "WATER_GUN", "HYDRO_PUMP", "SURF", "BUBBLEBEAM", "THUNDER", "WATERFALL",
  "CLAMP", "BUBBLE", "CRABHAMMER", "OCTAZOOKA", "WHIRLPOOL",
];

// Rain Dance (AI_Smart_RainDance): greatly discouraged against a Water-type (it
// would hand the player the boost), taken eagerly against a Fire-type, and
// otherwise only worth it when the enemy has something on RainDanceMoves to
// spend the weather on.
// Lua: Ai.lua:1144
S.EFFECT_RAIN_DANCE = (ctx, st) => {
  const verdict = weatherTypeVerdict(st.playerTypes, "WATER", "FIRE");
  if (verdict === "bad") return BAD_WEATHER;
  if (verdict === "good") return goodWeatherType(ctx, st);
  return weatherMove(ctx, st, RAIN_DANCE_MOVES);
};

// data/battle/ai/sunny_day_moves.asm, in list order.  CART BUG, kept: the list
// leaves out SOLARBEAM, FLAME_WHEEL and MOONLIGHT, so the AI never encourages
// Sunny Day for the three moves that want it most
// (docs/bugs_and_glitches.md).
// Lua: Ai.lua:1155
const SUNNY_DAY_MOVES = [
  "FIRE_PUNCH", "EMBER", "FLAMETHROWER", "FIRE_SPIN", "FIRE_BLAST",
  "SACRED_FIRE", "MORNING_SUN", "SYNTHESIS",
];

// Sunny Day (AI_Smart_SunnyDay): the mirror of Rain Dance, Fire-type bad and
// Water-type good, sharing AI_Smart_WeatherMove by fallthrough in the cart.
// Lua: Ai.lua:1162
S.EFFECT_SUNNY_DAY = (ctx, st) => {
  const verdict = weatherTypeVerdict(st.playerTypes, "FIRE", "WATER");
  if (verdict === "bad") return BAD_WEATHER;
  if (verdict === "good") return goodWeatherType(ctx, st);
  return weatherMove(ctx, st, SUNNY_DAY_MOVES);
};

// Psych Up copies the player's stat levels, so it is only worth it when the
// player is the one who has been setting up: AI_Smart_PsychUp sums both sides
// and discourages when the enemy is already ahead.
// Two cart quirks, both kept.  The sums walk NUM_LEVEL_STATS = 8 entries, one
// past EVASION into the ABILITY slot BattleCommand_Curse uses; both sides read
// the same slot, so the comparison is unchanged and the port sums the seven real
// stages.  And the encouraging tail asks for a player evasion that is both at
// least +2 and below +1, so its 80% dec [hl] is dead code the cart itself
// flags: this handler can only ever return +1 or 0.
// Lua: Ai.lua:1178
S.EFFECT_PSYCH_UP = (ctx, st) => {
  const mine = st.stages;
  const theirs = st.playerStages;
  if (!(T(mine) && T(theirs))) return 0;
  let enemySum = 0;
  let playerSum = 0;
  for (const key of STAGE_KEYS) {
    enemySum = enemySum + (mine[key] ?? 0);
    playerSum = playerSum + (theirs[key] ?? 0);
  }
  if (enemySum >= playerSum) return 1;
  if ((theirs.accuracy ?? 0) < -1) return 0;
  if ((theirs.evasion ?? 0) < 2) return 0;
  // Never reached: evasion cannot be at least +2 and below +1 at once.
  if ((theirs.evasion ?? 0) >= 1) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -1;
};

// Mirror Coat answers special damage, so AI_Smart_MirrorCoat counts how many of
// the moves the player has ACTUALLY used are special AND do damage.  Three or
// more is enough on its own; one or two only counts when the player's last move
// was special damage too; none at all is discouraged outright.  This is
// AI_Smart_Counter's routine with `jr c` and `jr nc` swapped on the type test.
// Lua: Ai.lua:1200
S.EFFECT_MIRROR_COAT = (ctx, st, _matchup, _damage, playerLastPower) => {
  const special = st.playerSpecialMoves;
  if (special == null) return 0;
  if (special === 0) return 1;
  let encourage = special >= 3;
  if (!encourage) {
    encourage = st.playerLastMove != null && (playerLastPower ?? 0) > 0 && st.playerLastMoveSpecial === true;
  }
  if (!encourage) return 0;
  if (chance(ctx.random, 39)) return 0;
  return -1;
};

// Twister and Gust share one body (AI_Smart_Twister falls straight into
// AI_Smart_Gust): both hit a target that is up in the air, so the cart only
// looks at them when the player's last move was Fly.  Already flying and slower
// than the enemy is a free double hit; still on the ground is a coin flip on
// predicting the Fly, and only from behind, since going second is what lands
// the hit.  This reads SUBSTATUS_FLYING specifically, not the FLYING|UNDERGROUND
// mask st.playerFlying carries.
// Lua: Ai.lua:1221
const smartGust: SmartHandler = (ctx, st) => {
  if (st.playerLastMove !== "FLY") return 0;
  if (T(st.playerFlyingUp)) {
    if (!T(st.enemyFaster)) return 0;
    return -2;
  }
  // .couldFly: try to predict the Fly this turn.
  if (T(st.enemyFaster)) return 0;
  if (chance(ctx.random, 50)) return 0;
  return -1;
};
S.EFFECT_TWISTER = smartGust;

// AI_Smart_Earthquake is the label AI_Smart_Magnitude sits on.
S.EFFECT_EARTHQUAKE = smartEarthquake;

// Future Sight (AI_Smart_FutureSight) lands a turn late, which is exactly when
// a player who is flying or underground comes back down.  The cart checks the
// speed first here and the substatus first in AI_Smart_Fly; same answer either
// way, and both read the combined FLYING|UNDERGROUND mask.
// Lua: Ai.lua:1241
S.EFFECT_FUTURE_SIGHT = (_ctx, st) => {
  if (!T(st.enemyFaster)) return 0;
  if (!T(st.playerFlying)) return 0;
  return -2;
};

// AI_Smart_Gust shares AI_Smart_Twister's body; see smartGust above.
S.EFFECT_GUST = smartGust;

// Stomp (AI_Smart_Stomp) doubles against a minimized target, so an 80%
// encourage once the player has used Minimize at all.
// Lua: Ai.lua:1252
S.EFFECT_STOMP = (ctx, st) => {
  if (!T(st.playerMinimized)) return 0;
  if (chance(ctx.random, 20)) return 0;
  return -1;
};

// SolarBeam (AI_Smart_Solarbeam) skips its charge turn in sun and is halved in
// rain, and the cart scores exactly that: 80% to greatly encourage while the
// sun is out, 90% to greatly discourage while it is raining, no opinion in
// anything else.
// Lua: Ai.lua:1262
S.EFFECT_SOLARBEAM = (ctx, st) => {
  if (st.weather === "sun") {
    if (chance(ctx.random, 20)) return 0;
    return -2;
  }
  if (st.weather !== "rain") return 0;
  if (chance(ctx.random, 10)) return 0;
  return 2;
};

// Thunder (AI_Smart_Thunder) drops to 50% accuracy in sun, so a 90% chance to
// discourage it while the sun is out.  The cart scores nothing at all for rain,
// even though Thunder never misses then: that asymmetry is the routine as
// written.
// Lua: Ai.lua:1276
S.EFFECT_THUNDER = (ctx, st) => {
  if (st.weather !== "sun") return 0;
  if (chance(ctx.random, 10)) return 0;
  return 1;
};

// Fly and Dig, both EFFECT_FLY (AI_Smart_Fly): a semi-invulnerable player is
// about to come back down, so a FASTER enemy can start its own two-turn move
// now and land it as the player reappears.  Three dec [hl], the layer's
// strongest push.  AICompareSpeed returns carry when the ENEMY is faster and
// the routine is `ret nc`, which reads backwards against the cart's own comment.
// Lua: Ai.lua:1287
S.EFFECT_FLY = (_ctx, st) => {
  if (!T(st.playerFlying)) return 0;
  if (!T(st.enemyFaster)) return 0;
  return -3;
};

// The two blocks AI_Setup keys off: EFFECT_ATTACK_UP..EFFECT_EVASION_UP and
// their _2 forms raise the user, the _DOWN forms lower the target.
// Lua: Ai.lua:75
const STAT_UP_EFFECTS: Record<string, boolean> = {};
const STAT_DOWN_EFFECTS: Record<string, boolean> = {};
for (const stat of ["ATTACK", "DEFENSE", "SPEED", "SP_ATK", "SP_DEF", "ACCURACY", "EVASION"]) {
  STAT_UP_EFFECTS["EFFECT_" + stat + "_UP"] = true;
  STAT_UP_EFFECTS["EFFECT_" + stat + "_UP_2"] = true;
  STAT_DOWN_EFFECTS["EFFECT_" + stat + "_DOWN"] = true;
  STAT_DOWN_EFFECTS["EFFECT_" + stat + "_DOWN_2"] = true;
}

export const Ai = {
  // constants/trainer_data_constants.asm, shift_const order.
  // Lua: Ai.lua:19
  FLAGS: {
    BASIC: 0x0001,
    SETUP: 0x0002,
    TYPES: 0x0004,
    OFFENSIVE: 0x0008,
    SMART: 0x0010,
    OPPORTUNIST: 0x0020,
    AGGRESSIVE: 0x0040,
    CAUTIOUS: 0x0080,
    STATUS: 0x0100,
    RISKY: 0x0200,
  } as Record<string, number>,

  // AIChooseMove seeds every slot with this before the layers run.
  BASE_SCORE: 20,

  // BASE_AI_SWITCH_SCORE: CheckPlayerMoveTypeMatchups starts here and walks the
  // score down for every super-effective move the player has shown.
  BASE_SWITCH_SCORE: 10,

  // TrainerClassAttributes is {item1, item2, baseMoney, aiLo, aiHi, switchLo,
  // switchHi, pad}; the AI word is bytes 4 and 5, little-endian (0-based [3],
  // [4] of the importer's array).
  // Lua: Ai.lua:41
  flagsOf(attributes: any): number {
    if (typeof attributes !== "object" || attributes === null) return 0;
    return (attributes[3] ?? 0) + (attributes[4] ?? 0) * 256;
  },

  // Lua: Ai.lua:46
  has(flags: number | undefined, name: string): boolean {
    const bit = Ai.FLAGS[name];
    if (!bit) return false;
    return mod(Math.floor((flags ?? 0) / bit), 2) === 1;
  },

  // data/battle/ai/stall_moves.asm and residual_moves.asm, keyed by effect: the
  // moves AI_Opportunist stops using when it is nearly dead and the ones
  // AI_Cautious stops using after its first turn.
  // Lua: Ai.lua:55
  STALL_EFFECTS: {
    EFFECT_HEAL: true, EFFECT_TOXIC: true, EFFECT_LEECH_SEED: true,
    EFFECT_LIGHT_SCREEN: true, EFFECT_REFLECT: true, EFFECT_SAFEGUARD: true,
    EFFECT_MIST: true, EFFECT_SUBSTITUTE: true, EFFECT_PERISH_SONG: true,
    EFFECT_MEAN_LOOK: true, EFFECT_SPIKES: true, EFFECT_ATTRACT: true,
    EFFECT_CONFUSE: true, EFFECT_DISABLE: true, EFFECT_ENCORE: true,
    EFFECT_RAIN_DANCE: true, EFFECT_SUNNY_DAY: true, EFFECT_SANDSTORM: true,
    EFFECT_MORNING_SUN: true, EFFECT_SYNTHESIS: true, EFFECT_MOONLIGHT: true,
  } as Record<string, boolean>,

  // Lua: Ai.lua:65
  RESIDUAL_EFFECTS: {
    EFFECT_TOXIC: true, EFFECT_LEECH_SEED: true, EFFECT_NIGHTMARE: true,
    EFFECT_CURSE: true, EFFECT_SPIKES: true, EFFECT_PERISH_SONG: true,
    EFFECT_MEAN_LOOK: true, EFFECT_ATTRACT: true, EFFECT_ENCORE: true,
    EFFECT_DISABLE: true, EFFECT_LIGHT_SCREEN: true, EFFECT_REFLECT: true,
    EFFECT_SAFEGUARD: true, EFFECT_MIST: true,
  } as Record<string, boolean>,

  STAT_UP_EFFECTS,
  STAT_DOWN_EFFECTS,

  // Effects that do nothing but inflict a major status, which is what the
  // BASIC and STATUS layers care about.
  // Lua: Ai.lua:87
  STATUS_EFFECTS: {
    EFFECT_SLEEP: "sleep",
    EFFECT_POISON: "poison",
    EFFECT_TOXIC: "toxic",
    EFFECT_PARALYZE: "paralyze",
    EFFECT_BURN: "burn",
    EFFECT_FREEZE: "freeze",
    EFFECT_CONFUSE: "confuse",
  } as Record<string, string>,

  SMART: S,

  // `71 percent - 1`, the raw ($ff-scaled) accuracy AI_Smart_LockOn calls shaky.
  LOCK_ON_ACCURACY: 0xb4,

  // AI_Smart_LockOn's `.player_locked_on` half, as a post-pass over the finished
  // score table.  With the lock-on already up the layer stops caring about its
  // own slot and doubly encourages every move the enemy would otherwise struggle
  // to land ("dec [hl]" twice per move under `71 percent - 1`); the `.dismiss`
  // tail that then buries Lock-On itself is what S.EFFECT_LOCK_ON returns.
  //
  // The loop is per Lock-On in the list, not per turn: a mon carrying both
  // Lock-On and Mind Reader runs the scoring layer twice and so lands the
  // encouragement twice, which is exactly what the cart does.
  //
  // `defs` is the move definition for each score slot, in the same order.
  // Lua: Ai.lua:790
  lockOnPostPass(scores: number[], defs: any[]): number[] {
    let rounds = 0;
    for (let i = 0; i < scores.length; i++) {
      const def = defs[i];
      if (T(def) && def.effect === "EFFECT_LOCK_ON") rounds = rounds + 1;
    }
    if (rounds === 0) return scores;
    for (let i = 0; i < scores.length; i++) {
      const def = defs[i];
      // accuracyRaw is the cart's own byte; the percentage is the fallback for a
      // caller that only has the human-readable number.
      const raw = T(def)
        ? T(def.accuracyRaw)
          ? def.accuracyRaw
          : T(def.accuracy)
            ? Math.floor((def.accuracy * 255) / 100)
            : undefined
        : undefined;
      if (T(raw) && raw < Ai.LOCK_ON_ACCURACY) {
        scores[i] = scores[i]! - 2 * rounds;
      }
    }
    return scores;
  },

  //--------------------------------------------------------------------------
  // The switch / item layer (engine/battle/ai/items.asm, switch.asm)
  //--------------------------------------------------------------------------
  //
  // TRNATTR_AI_ITEM_SWITCH is bytes 6-7 of the class attributes.  Three flags
  // decide how eager the class is to rotate; CheckAbleToSwitch scores the bench
  // and the flag turns that score into a probability.

  // Lua: Ai.lua:1301
  SWITCH_FLAGS: {
    OFTEN: 0x0001,
    RARELY: 0x0002,
    SOMETIMES: 0x0004,
  } as Record<string, number>,

  // Lua: Ai.lua:1307
  switchFlagsOf(attributes: any): number {
    if (typeof attributes !== "object" || attributes === null) return 0;
    return (attributes[5] ?? 0) + (attributes[6] ?? 0) * 256;
  },

  // CheckAbleToSwitch's answer, as its two nybbles: the high one is how strongly
  // the AI wants to rotate ($10 / $20 / $30) and the low one is the party slot.
  // Perish Song at one turn left is the maximum; otherwise it is whether the
  // player's moves beat what is out and something on the bench does better.
  //
  // state:
  //   bench        array of { index, mon, resists, superEffective, healthy }
  //   perishCount  the active mon's perish counter, or nil
  //   matchupScore CheckPlayerMoveTypeMatchups' score (10 is neutral)
  //
  // Returns [weight, index]; `index` is whatever the bench entries carry.
  // Lua: Ai.lua:1321
  switchScore(state?: any): [number, any] {
    state = state ?? {};
    const candidates: any[] = [];
    for (const entry of state.bench ?? []) {
      if (T(entry.healthy)) candidates.push(entry);
    }
    if (candidates.length === 0) return [0, undefined];
    if (state.perishCount === 1) {
      return [0x30, candidates[0].index];
    }
    // Below BASE_AI_SWITCH_SCORE means the player's moves are winning.
    if ((state.matchupScore ?? 10) >= 10) return [0, undefined];
    let best: any;
    let weight = 0;
    for (const entry of candidates) {
      if (T(entry.resists) && T(entry.superEffective)) {
        best = entry.index;
        weight = 0x20;
        break;
      } else if (T(entry.resists) && !T(best)) {
        best = entry.index;
        weight = 0x10;
      }
    }
    if (!T(best)) return [0, undefined];
    return [weight, best];
  },

  // The flag turns the score into a roll.  These are the cart's own percentages
  // (SwitchOften / SwitchRarely / SwitchSometimes), and a score of $30 inverts
  // the test: the AI switches UNLESS the roll comes up.
  // Lua: Ai.lua:1349
  SWITCH_CHANCES: {
    OFTEN: { [0x10]: 50, [0x20]: 79, [0x30]: 96 },
    SOMETIMES: { [0x10]: 20, [0x20]: 50, [0x30]: 80 },
    RARELY: { [0x10]: 8, [0x20]: 12, [0x30]: 21 },
  } as Record<string, Record<number, number>>,

  // Lua: Ai.lua:1355
  shouldSwitch(attributes: any, score: number, random?: ZeroRandom): boolean {
    if (score === 0) return false;
    const flags = Ai.switchFlagsOf(attributes);
    let name: string | undefined;
    // pairs() order: sorted for determinism (alphabetical is also bit order here)
    for (const key of sortedKeys(Ai.SWITCH_FLAGS)) {
      const mask = Ai.SWITCH_FLAGS[key]!;
      if (mod(Math.floor(flags / mask), 2) === 1) {
        name = key;
        break;
      }
    }
    if (name == null) return false;
    const percent = (Ai.SWITCH_CHANCES[name] ?? {})[score];
    if (percent == null) return false;
    return (random ? random(100) : 0) + 1 <= percent;
  },

  // AI_TryItem's table, in the order the cart walks it: the first item the
  // trainer holds whose condition is met is the one used.  A trainer only uses
  // an item at all when its active mon is its highest-level one (.IsHighestLevel).
  // Lua: Ai.lua:1371
  ITEM_ORDER: [
    "FULL_RESTORE", "MAX_POTION", "HYPER_POTION", "SUPER_POTION", "POTION",
    "X_ACCURACY", "FULL_HEAL", "GUARD_SPEC", "DIRE_HIT", "X_ATTACK",
    "X_DEFEND", "X_SPEED", "X_SPECIAL",
  ] as string[],

  // Lua: Ai.lua:1377
  HEAL_ITEMS: {
    FULL_RESTORE: Infinity,
    MAX_POTION: Infinity,
    HYPER_POTION: 200,
    SUPER_POTION: 50,
    POTION: 20,
  } as Record<string, number>,

  // The healing items want the mon below half and missing at least what they
  // would restore; FULL_HEAL wants a status.  Everything else is a stat booster
  // and is used on the first turn.
  // Lua: Ai.lua:1385
  chooseItem(state?: any): string | undefined {
    state = state ?? {};
    const held: Record<string, boolean> = {};
    for (const id of state.items ?? []) held[id] = true;
    if (!T(state.isHighestLevel)) return undefined;
    const hp: number = state.hp ?? 0;
    const maxHp: number = state.maxHp ?? 1;
    for (const id of Ai.ITEM_ORDER) {
      if (held[id]) {
        const heal = Ai.HEAL_ITEMS[id];
        if (heal != null) {
          if (hp * 2 <= maxHp && maxHp - hp >= Math.min(heal, maxHp) / 2) {
            return id;
          }
        } else if (id === "FULL_HEAL") {
          if (T(state.status)) return id;
        } else if ((state.enemyTurns ?? 0) === 0) {
          return id;
        }
      }
    }
    return undefined;
  },

  //--------------------------------------------------------------------------
  // The scoring layers, as ai_classes records
  //--------------------------------------------------------------------------
  //
  // One record per AI_* pass of engine/battle/ai/scoring.asm, in the shape
  // src/mods/Schemas.lua's `ai_classes` registry validates.  Same registry NAME
  // Gen 1 fills from src/battle/TrainerAI.lua, the same `kind = "layer"`, and
  // the same score signature fn(view, def, score) -> score.
  //
  // The ids are the TRNATTR_AI_MOVE_WEIGHTS flag names, which is what makes them
  // addressable: `flag` names the bit in Ai.FLAGS that turns the layer on, so a
  // class with no bits set runs no layers at all -- AIChooseMove's own answer
  // when wEnemyTrainerAIFlags is zero.  `flag` is the one field Gen 2 adds; a
  // mod's own layer may leave it out, and then it runs for every class that runs
  // any AI at all.
  //
  // `view` is the state a layer scores against, rebuilt per move by Ai.choose:
  //   context / random / flags     the caller's own
  //   attacker / defender          the two mons, types resolved
  //   move / damage / damaging / status   the move being scored
  //   best                         the highest expected damage of the set
  // Lua: Ai.lua:1430
  LAYERS: {
    // AI_Basic: never throw a status move at a target that already has one, and
    // never use a move whose only effect has already landed.  The confusion
    // moves read SUBSTATUS_CONFUSED (defender.confused), not the status byte,
    // since confusion is a volatile on the cart.
    BASIC: {
      kind: "layer",
      flag: "BASIC",
      score: (view: any, _def: any, score: number): number => {
        const status = view.status;
        const defender = view.defender;
        if (T(status) && (T(defender.status) || (status === "confuse" && T(defender.confused)))) {
          return score + 5;
        }
        return score;
      },
    },
    // AI_Types: dismiss what the target is immune to, encourage super-effective,
    // discourage not very effective.
    TYPES: {
      kind: "layer",
      flag: "TYPES",
      score: (view: any, def: any, score: number): number => {
        if (!T(view.damaging)) return score;
        const matchup = matchupOf(view.context, def, view.defender);
        if (matchup === 0) return score + 10;
        if (matchup > 10) return score - 1;
        if (matchup < 10) return score + 1;
        return score;
      },
    },
    // AI_Offensive: discourage anything that does not do damage.
    OFFENSIVE: {
      kind: "layer",
      flag: "OFFENSIVE",
      score: (view: any, _def: any, score: number): number => {
        if (T(view.damaging)) return score;
        return score + 1;
      },
    },
    // AI_Aggressive: encourage whichever move hits hardest and discourage every
    // other damaging one.
    AGGRESSIVE: {
      kind: "layer",
      flag: "AGGRESSIVE",
      score: (view: any, _def: any, score: number): number => {
        if (!T(view.damaging)) return score;
        if (view.damage >= view.best && view.best > 0) return score - 1;
        return score + 1;
      },
    },
    // AI_Status: refuse a status move outright against a target that already has
    // that status.
    STATUS: {
      kind: "layer",
      flag: "STATUS",
      score: (view: any, _def: any, score: number): number => {
        if (T(view.status) && view.defender.status === view.status) {
          return score + 10;
        }
        return score;
      },
    },
    // AI_Risky: take a kill when one is on the table, whatever else says.
    RISKY: {
      kind: "layer",
      flag: "RISKY",
      score: (view: any, _def: any, score: number): number => {
        if (view.damage >= (view.defender.hp ?? 0) && view.damage > 0) {
          return score - 5;
        }
        return score;
      },
    },
    // AI_Setup: stat moves on turn one, and almost never after.
    SETUP: {
      kind: "layer",
      flag: "SETUP",
      score: (view: any, def: any, score: number): number => {
        const context = view.context;
        const random: ZeroRandom = view.random;
        const up = Ai.STAT_UP_EFFECTS[def.effect];
        const down = Ai.STAT_DOWN_EFFECTS[def.effect];
        if (up) {
          if ((context.enemyTurns ?? 0) === 0 && random(2) === 0) {
            return score - 2;
          }
          return score + 2;
        } else if (down) {
          if ((context.playerTurns ?? 0) === 0 && random(2) === 0) {
            return score - 2;
          }
          return score + 2;
        }
        return score;
      },
    },
    // AI_Opportunist: no stalling when the enemy is nearly dead.
    OPPORTUNIST: {
      kind: "layer",
      flag: "OPPORTUNIST",
      score: (view: any, def: any, score: number): number => {
        if (!Ai.STALL_EFFECTS[def.effect]) return score;
        const hp = view.context.enemyHp;
        const maxHp = view.context.enemyMaxHp;
        if (!(T(hp) && T(maxHp) && hp * 2 <= maxHp)) return score;
        const low = hp * 4 <= maxHp;
        if (low || view.random(2) === 0) return score + 1;
        return score;
      },
    },
    // AI_Cautious: 90% chance to drop a residual move after turn one.
    CAUTIOUS: {
      kind: "layer",
      flag: "CAUTIOUS",
      score: (view: any, def: any, score: number): number => {
        if ((view.context.enemyTurns ?? 0) <= 0) return score;
        if (!Ai.RESIDUAL_EFFECTS[def.effect]) return score;
        if (view.random(100) < 90) return score + 1;
        return score;
      },
    },
    // AI_Smart: the per-effect layer.  Ai.lockOnPostPass is its one pass that
    // edits somebody else's slot, so Ai.choose runs that after the move loop.
    SMART: {
      kind: "layer",
      flag: "SMART",
      score: (view: any, def: any, score: number): number => {
        const handler = Ai.SMART[def.effect];
        if (!handler) return score;
        const context = view.context;
        const random: ZeroRandom = view.random;
        const state = context.smart ?? {};
        state.random = state.random ?? random;
        // AI_Smart_SpeedDownHit is the one handler that reads the move it is
        // scoring (wEnemyMoveStruct + MOVE_ANIM), so the id rides along.
        const delta = handler(
          { random, moveId: view.move.id },
          state,
          matchupOf(context, def, view.defender),
          view.damage,
          context.playerLastPower,
        );
        return score + (delta ?? 0);
      },
    },
  } as Record<string, AiLayer>,

  // scoring.asm's own order.  It is load bearing: SETUP, OPPORTUNIST and
  // CAUTIOUS each roll, so a reordering changes which move gets which byte.
  // Lua: Ai.lua:1543
  LAYER_ORDER: [
    "BASIC", "TYPES", "OFFENSIVE", "AGGRESSIVE", "STATUS", "RISKY",
    "SETUP", "OPPORTUNIST", "CAUTIOUS", "SMART",
  ] as string[],

  // vanilla registrations, engine-owned (Schemas.ENGINE), so a mod's register of
  // one of these ids collides the way it does on Red and has to say override
  // Lua: Ai.lua:1550
  registerInto(registry: any, _data: any, owner?: any): void {
    // pairs() order: sorted for determinism
    for (const id of sortedKeys(Ai.LAYERS)) {
      registry.register(id, Ai.LAYERS[id], owner);
    }
  },

  // the merged `ai_classes` record for an id, the module's own when no loader ran
  // Lua: Ai.lua:1557
  classFor(data: any, id: string | null | undefined): AiLayer | undefined {
    if (id == null) return undefined;
    const merged = T(data) ? data.gen2AiClasses : undefined;
    return (T(merged) && T(merged[id]) ? merged[id] : undefined) ?? Ai.LAYERS[id];
  },

  // The ordered layer list for one AI word: the vanilla ten in scoring.asm order
  // first, each resolved through the registry so a mod's patch of AI_Smart is the
  // one that runs, then any layer a mod registered under a new id, in sorted id
  // order so the roll sequence is the same on every boot.  A layer's `flag` gates
  // it on the class's bits; a mod layer without one runs for every class that
  // runs any AI at all, which is the only honest default when the ten flag bits
  // are all spoken for.
  // Lua: Ai.lua:1570
  layersFor(data: any, flags: number): AiLayer[] {
    const out: AiLayer[] = [];
    const seen: Record<string, boolean> = {};
    for (const id of Ai.LAYER_ORDER) {
      seen[id] = true;
      if (Ai.has(flags, id)) {
        const record = Ai.classFor(data, id);
        if (T(record) && T(record!.score)) out.push(record!);
      }
    }
    const merged = T(data) ? data.gen2AiClasses : undefined;
    if (T(merged)) {
      const extra: string[] = [];
      for (const id of Object.keys(merged)) {
        const record = merged[id];
        if (
          !seen[id] &&
          T(record) &&
          T(record.score) &&
          (record.kind == null || record.kind === "layer") &&
          (record.flag == null || Ai.has(flags, record.flag))
        ) {
          extra.push(id);
        }
      }
      extra.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const id of extra) out.push(merged[id]);
    }
    return out;
  },

  // context:
  //   moves        array of { id, pp } the enemy may use
  //   moveDef(id)  the move record
  //   attacker     the enemy mon, with .types resolved
  //   defender     the player's mon, with .types resolved
  //   typeChart    { types, matchups }
  //   attackerStages / defenderStages
  //   flags        the class's AI word
  //   random(n)    0..n-1
  //
  // Returns [chosen move id, score table] (the score table for the tests to
  // read; 0-based, one slot per move with PP, in order).
  // Lua: Ai.lua:1606
  choose(context: any): [string | undefined, number[]] {
    const moves: any[] = [];
    for (const move of context.moves ?? []) {
      if ((move.pp ?? 0) > 0) moves.push(move);
    }
    if (moves.length === 0) return [undefined, []];

    const random: ZeroRandom = context.random ?? ((_n: number) => 0);
    const flags: number = context.flags ?? 0;
    if (flags === 0) {
      // No AI: pick at random, the way a wild mon does.
      return [moves[random(moves.length)].id, []];
    }

    const attacker = context.attacker ?? {};
    const defender = context.defender ?? {};
    const scores: number[] = [];
    const damages: number[] = [];
    const defs: any[] = [];
    let best = -1;
    moves.forEach((move, i) => {
      scores[i] = Ai.BASE_SCORE;
      const def = T(context.moveDef) ? context.moveDef(move.id) : undefined;
      defs[i] = def;
      damages[i] = T(def) ? expectedDamage(context, attacker, defender, def) : 0;
      if (damages[i]! > best) best = damages[i]!;
    });

    // The scoring layers this class runs, resolved once: which records exist is
    // a property of the boot, not of the move being scored, and the per-move
    // loop below is hot.
    const layers = Ai.layersFor(context.data, flags);

    const view: any = {
      context,
      random,
      flags,
      attacker,
      defender,
      best,
    };
    moves.forEach((move, i) => {
      const def = defs[i];
      if (T(def)) {
        // the per-move half of the view, rebuilt in place so ten layers share
        // one table rather than allocating ten
        view.move = move;
        view.damage = damages[i];
        view.damaging = (def.power ?? 0) > 0;
        view.status = Ai.STATUS_EFFECTS[def.effect];
        for (const record of layers) {
          const next = record.score(view, def, scores[i]!);
          scores[i] = T(next) ? next! : scores[i]!;
        }
      }
    });

    // The one scoring layer that edits somebody else's slot, so it cannot run
    // inside the per-move pass above.
    if (Ai.has(flags, "SMART") && T((context.smart ?? {}).playerLockOn)) {
      Ai.lockOnPostPass(scores, defs);
    }

    // Lowest score wins; ties are broken by a roll so a trainer is not perfectly
    // predictable turn to turn.
    let lowest = Infinity;
    for (const score of scores) {
      if (score < lowest) lowest = score;
    }
    const tied: string[] = [];
    scores.forEach((score, i) => {
      if (score === lowest) tied.push(moves[i].id);
    });
    return [tied[random(tied.length)], scores];
  },
};

export default Ai;
