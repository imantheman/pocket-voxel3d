// Port of gen1recomp src/core/game3/battle/effects/init.lua (GPLv3 + additional terms; see LICENSE.md).
// Owned effect registry. Dispatch is driven by ROM gBattleMoves.effect
// via EffectIds.STATUS_SETUP (see effect_ids.lua). Name fallbacks are last resort.
//
// Port notes:
// - Brian fills the registry at module load by reading the nine handler
//   modules' tables (hazards, screens, stats, status, healing, setup,
//   volatiles, weather, special). Under ES module order that read is a TDZ
//   ReferenceError whenever one of them is still evaluating above this
//   module (e.g. a test that imports effects/stats.ts first: stats -> ... ->
//   engine -> effects -> init). So the same reg() calls run once, on the
//   first Effects.get/run/runForMove/ids. The registry is private, so no
//   caller can tell the difference.
// - pcall(fn, ctx) + error(err, 0) is try/catch with a rethrow after pop().
// - Effects.ids() returns a sorted Lua sequence (slot 0 unused).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import { pairs, len, sort, type LuaTable } from "../../../platform/lt.ts";
import Hazards from "./hazards.ts";
import Screens from "./screens.ts";
import Stats from "./stats.ts";
import Status from "./status.ts";
import Healing from "./healing.ts";
import Setup from "./setup.ts";
import Volatiles from "./volatiles.ts";
import Weather from "./weather.ts";
import Special from "./special.ts";
import EffectCtx, { type EffectContext } from "../effect_ctx.ts";
import Moves from "../moves.ts";
import EffectIds from "../effect_ids.ts";

export type EffectFn = (ctx: EffectContext) => any;

const registry: Record<string, EffectFn> = {};

// Lua: init.lua:21
function reg(id: string, fn: EffectFn): void {
  registry[id] = fn;
}

let registered = false;

// Lua: init.lua:25-109
// FRLG-legal handlers only (no Stealth Rock / Trick Room / Aqua Ring / ...).
function register_all(): void {
  registered = true;
  reg("EXP_SPIKES_EFFECT", Hazards.spikes);
  reg("EXP_SAFEGUARD_EFFECT", Screens.safeguard);
  reg("EXP_REFLECT_EFFECT", Screens.reflect);
  reg("EXP_LIGHT_SCREEN_EFFECT", Screens.lightScreen);
  reg("EXP_BURN_EFFECT", Status.burn);
  reg("EXP_POISON_EFFECT", Status.poison);
  reg("EXP_TOXIC_EFFECT", Status.toxic);
  reg("EXP_SLEEP_EFFECT", Status.sleep);
  reg("EXP_PARALYZE_EFFECT", Status.paralyze);
  reg("EXP_TAUNT_EFFECT", Status.taunt);
  reg("EXP_YAWN_EFFECT", Status.yawn);
  reg("EXP_REFRESH_EFFECT", Healing.refresh);
  reg("EXP_INGRAIN_EFFECT", Healing.ingrain);
  reg("EXP_RECOVER_EFFECT", Healing.recover);
  reg("EXP_SOFTBOILED_EFFECT", Healing.softboiled);
  reg("EXP_BELLY_DRUM_EFFECT", Healing.bellyDrum);
  reg("EXP_WISH_EFFECT", Healing.wish);
  reg("EXP_HEAL_BELL_EFFECT", Healing.healBell);
  reg("EXP_PAIN_SPLIT_EFFECT", Healing.painSplit);
  reg("EXP_SWALLOW_EFFECT", Healing.swallow);
  reg("EXP_MEAN_LOOK_EFFECT", Setup.meanLook);
  reg("EXP_LEECH_SEED_EFFECT", Setup.leechSeed);
  reg("EXP_DESTINY_BOND_EFFECT", Setup.destinyBond);
  reg("EXP_NIGHTMARE_EFFECT", Setup.nightmare);
  reg("EXP_FOCUS_ENERGY_EFFECT", Setup.focusEnergy);
  reg("EXP_FORESIGHT_EFFECT", Setup.foresight);
  reg("EXP_LOCK_ON_EFFECT", Setup.lockOn);
  reg("EXP_MAGIC_COAT_EFFECT", Setup.magicCoat);
  reg("EXP_GRUDGE_EFFECT", Setup.grudge);
  reg("EXP_IMPRISON_EFFECT", Setup.imprison);
  reg("EXP_SNATCH_EFFECT", Setup.snatch);
  reg("EXP_MUD_SPORT_EFFECT", Setup.mudSport);
  reg("EXP_WATER_SPORT_EFFECT", Setup.waterSport);
  reg("EXP_CAMOUFLAGE_EFFECT", Setup.camouflage);
  reg("EXP_ROLE_PLAY_EFFECT", Setup.rolePlay);
  reg("EXP_SKILL_SWAP_EFFECT", Setup.skillSwap);
  reg("EXP_FUTURE_SIGHT_EFFECT", Setup.futureSight);
  reg("EXP_CURSE_EFFECT", Setup.curse);
  reg("EXP_HELPING_HAND_EFFECT", Setup.helpingHand);
  reg("EXP_CONFUSE_EFFECT", Setup.confuse);
  reg("EXP_HAZE_EFFECT", Setup.haze);
  reg("EXP_SUBSTITUTE_EFFECT", Setup.substitute);
  reg("EXP_TEETER_DANCE", Setup.teeterDance);
  reg("EXP_MIST_EFFECT", Screens.mist);
  reg("EXP_REST_EFFECT", Healing.rest);
  reg("EXP_SPLASH_EFFECT", Setup.splash);
  reg("EXP_BATON_PASS_EFFECT", Special.batonPass);
  reg("EXP_ROAR_EFFECT", Special.roar);
  reg("EXP_CONVERSION_EFFECT", Special.conversion);
  reg("EXP_CONVERSION_2_EFFECT", Special.conversion2);
  reg("EXP_TRANSFORM_EFFECT", Special.transform);
  reg("EXP_MIMIC_EFFECT", Special.mimic);
  reg("EXP_DISABLE_EFFECT", Special.disable);
  reg("EXP_SKETCH_EFFECT", Special.sketch);
  reg("EXP_TELEPORT_EFFECT", Special.teleport);
  reg("EXP_FOLLOW_ME_EFFECT", Special.followMe);
  reg("EXP_TRICK_EFFECT", Special.trick);
  reg("EXP_RECYCLE_EFFECT", Special.recycle);
  reg("EXP_MORNING_SUN_EFFECT", Healing.morningSun);
  reg("EXP_MINIMIZE_EFFECT", Stats.minimize);
  reg("EXP_DEFENSE_CURL_EFFECT", Stats.defenseCurl);
  reg("EXP_PROTECT_EFFECT", Volatiles.protect);
  reg("EXP_ENDURE_EFFECT", Volatiles.endure);
  reg("EXP_ENCORE_EFFECT", Volatiles.encore);
  reg("EXP_PERISH_SONG_EFFECT", Volatiles.perishSong);
  reg("EXP_ATTRACT_EFFECT", Volatiles.attract);
  reg("EXP_SPITE_EFFECT", Volatiles.spite);
  reg("EXP_TORMENT_EFFECT", Volatiles.torment);
  reg("EXP_WEATHER_SUNNY", Weather.sunny);
  reg("EXP_WEATHER_RAINY", Weather.rainy);
  reg("EXP_WEATHER_SANDSTORM", Weather.sandstorm);
  reg("EXP_WEATHER_HAIL", Weather.hail);
  reg("EXP_STAT_FROM_EFFECT", Stats.fromRomEffect);
  reg("EXP_SWAGGER_EFFECT", Stats.swagger);
  reg("EXP_FLATTER_EFFECT", Stats.flatter);
  reg("EXP_PSYCH_UP_EFFECT", Stats.psychUp);
  reg("EXP_STOCKPILE_EFFECT", Stats.stockpile);
  reg("EXP_CHARGE_EFFECT", Stats.charge);
  reg("EXP_MEMENTO_EFFECT", Stats.memento);
  reg("EXP_TICKLE_EFFECT", Stats.tickle);
  reg("EXP_COSMIC_POWER_EFFECT", Stats.cosmicPower);
  reg("EXP_CALM_MIND", Stats.calmMind);
  reg("EXP_BULK_UP", Stats.bulkUp);
  reg("EXP_DRAGON_DANCE", Stats.dragonDance);
}

/** The registry, filled on first use. */
function reg_table(): Record<string, EffectFn> {
  if (!registered) register_all();
  return registry;
}

export const Effects = {
  // Lua: init.lua:111
  get(id: string): EffectFn | undefined {
    return reg_table()[id];
  },

  // Lua: init.lua:115
  run(id: string, adapter: any, user: any, target: any, move: any, moveId?: any, moveCtx?: any): boolean {
    const fn = reg_table()[id];
    if (!truthy(fn)) return false;
    const ctx = EffectCtx.push(adapter, user, target, move, truthy(moveId) ? moveId : id, adapter.rng(), moveCtx);
    let ok = true;
    let err: unknown;
    try { fn(ctx); } catch (e) { ok = false; err = e; }
    EffectCtx.pop();
    if (!ok) throw err;
    return true;
  },

  // Lua: init.lua:126
  /** Prefer ROM effect byte -> STATUS_SETUP. */
  runForMove(adapter: any, user: any, target: any, moveId: any, moveCtx?: any): boolean {
    const move = (truthy(moveCtx) && truthy(moveCtx.move)) ? moveCtx.move : Moves.get(moveId);
    const effectByte = tonumber(truthy(move) ? move.effect : move);
    const effectId = effectByte != null ? EffectIds.STATUS_SETUP[effectByte] : null;
    if (!truthy(effectId)) return false;
    return Effects.run(effectId!, adapter, user, target, move, moveId, moveCtx);
  },

  // Lua: init.lua:134
  ids(): LuaTable {
    const out: LuaTable = [null];
    for (const [id] of pairs(reg_table())) out[len(out) + 1] = id;
    sort(out);
    return out;
  },
};

export default Effects;
