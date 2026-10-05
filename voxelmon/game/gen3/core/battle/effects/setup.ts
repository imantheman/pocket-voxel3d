// Port of gen1recomp src/core/game3/battle/effects/setup.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG setup effects (KR-sourced bodies; adapter-only; no KR require).
//
// Port notes:
// - The lazy requires (engine, damage, rules, state, effects.special,
//   effects.status) are static imports, used only inside the functions.
// - Setup.TERRAIN_TYPE (Brian builds it from Types.ID at module load) is
//   built on first read: types.ts -> rom_text.ts can reach the engine and
//   effects/init -> setup while types.ts is still evaluating, and a load-time
//   read of Types there is a TDZ ReferenceError under ES module order. Same
//   values; the field stays assignable.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy } from "../../../../../import/gen3/lua.ts";
import { ipairs, pairs, len, seq, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import Types from "../types.ts";
import Secondary from "./secondary.ts";
import Engine from "../engine.ts";
import Damage from "../damage.ts";
import Rules from "../rules.ts";
import State from "../state.ts";
import Special from "./special.ts";
import Status from "./status.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

let terrainType: Record<number, any> | null = null;

// Lua: setup.lua:9
function moved_last(ctx: EffectContext): boolean {
  const st = truthy(ctx.adapter) ? ctx.adapter._st : ctx.adapter;
  // pokefirered/src/battle_script_commands.c:9148
  if (truthy(st) && truthy(st.double)) return truthy(ctx.user) && ctx.user.expTurnOrder === 4;
  return truthy(ctx.user) && ctx.user.expTurnOrder === 2;
}

export const Setup = {
  // Lua: setup.lua:17
  // pokefirered/data/battle_scripts_1.s:1440
  meanLook(ctx: EffectContext): void {
    const t = ctx.target;
    if (!truthy(t)) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "noacc"))) return;
    if (truthy(t.expTrapped) || truthy(t.escapePrevention)) return H.sayFail(ctx);
    if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
    H.attackAnim(ctx);
    t.expTrapped = true;
    t.escapePrevention = true;
    t.expTrappedBy = ctx.user;
    ctx.adapter.sayText("STRINGID_TARGETCANTESCAPENOW", { def: t });
  },

  // Lua: setup.lua:31
  // pokefirered/src/battle_script_commands.c:6436
  leechSeed(ctx: EffectContext): void {
    const ad = ctx.adapter, t = ctx.target;
    if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
    const M = H.move(ctx);
    let hit: any = true;
    if (truthy(M)) hit = M.accuracyCheck("normal", false);
    H.attackAnim(ctx);
    if (!truthy(hit) || truthy(t.expSeeded)) {
      ad.sayText("STRINGID_PKMNEVADEDATTACK", { def: t });
      return;
    }
    if (H.hasType(ctx, t, Types.ID.GRASS)) {
      ad.sayText("STRINGID_ITDOESNTAFFECT", { def: t });
      return;
    }
    t.expSeeded = true;
    t.leechSeed = true;
    t.expSeedSource = ctx.user;
    ad.sayText("STRINGID_PKMNSEEDED", { def: t });
  },

  // Lua: setup.lua:53
  // pokefirered/data/battle_scripts_1.s:1330
  destinyBond(ctx: EffectContext): void {
    ctx.user.expDestinyBond = true;
    ctx.user.destinyBond = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNTRYINGTOTAKEFOE", { atk: ctx.user });
  },

  // Lua: setup.lua:61
  // pokefirered/data/battle_scripts_1.s:1455
  nightmare(ctx: EffectContext): void {
    const t = ctx.target;
    if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (truthy(t.expNightmare)) return H.sayFail(ctx);
    if (!truthy(ctx.adapter.hasStatus(t, "SLP"))) return H.sayFail(ctx);
    H.attackAnim(ctx);
    t.expNightmare = true;
    ctx.adapter.sayText("STRINGID_PKMNFELLINTONIGHTMARE", { def: t });
  },

  // Lua: setup.lua:72
  // pokefirered/data/battle_scripts_1.s:884
  focusEnergy(ctx: EffectContext): void {
    if (truthy(ctx.user.expFocusEnergy)) return H.sayFail(ctx);
    ctx.user.expFocusEnergy = true;
    ctx.user.focusEnergy = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNGETTINGPUMPED", { atk: ctx.user });
  },

  // Lua: setup.lua:81
  // pokefirered/data/battle_scripts_1.s:1551
  foresight(ctx: EffectContext): void {
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    ctx.target.expIdentified = true;
    ctx.target.foresight = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNIDENTIFIED", { atk: ctx.user, def: ctx.target });
  },

  // Lua: setup.lua:90
  // pokefirered/src/battle_script_commands.c:7759
  lockOn(ctx: EffectContext): void {
    if (lor(ctx.target.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    ctx.target.expLockedOn = 2;
    ctx.target.expLockedOnBy = ctx.user.side;
    ctx.target.expLockedOnById = ctx.user.id;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNTOOKAIM", { atk: ctx.user, def: ctx.target });
  },

  // Lua: setup.lua:101
  // pokefirered/src/battle_script_commands.c:9144
  magicCoat(ctx: EffectContext): void {
    if (moved_last(ctx)) return H.sayFail(ctx);
    ctx.user.expMagicCoat = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSHROUDEDITSELF", { atk: ctx.user, currentMove: H.moveNum(lor(ctx.move, ctx.moveId)) });
  },

  // Lua: setup.lua:109
  // pokefirered/data/battle_scripts_1.s:2527
  grudge(ctx: EffectContext): void {
    if (truthy(ctx.user.expGrudge)) return H.sayFail(ctx);
    ctx.user.expGrudge = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNWANTSGRUDGE", { atk: ctx.user });
  },

  // Lua: setup.lua:117
  // pokefirered/src/battle_script_commands.c:9019
  imprison(ctx: EffectContext): void {
    const user = ctx.user;
    if (truthy(user.expImprison)) return H.sayFail(ctx);
    const st = ctx.adapter._st;
    let foes: LuaTable = null;
    if (truthy(st) && truthy(st.double)) foes = ctx.adapter.foesOf(user);
    if (!truthy(foes)) foes = seq(ctx.adapter.foeOf(user));
    let shared = false;
    const um = truthy(user.mon) && truthy(user.mon.moves) ? user.mon.moves : [null];
    for (const [, foe] of ipairs(foes)) {
      const fm = truthy(foe) && truthy(foe.mon) && truthy(foe.mon.moves) ? foe.mon.moves : [null];
      for (let i = 1; i <= 4; i++) {
        const a = H.moveNum(um[i]);
        if (truthy(a) && a !== 0) {
          for (let j = 1; j <= 4; j++) {
            if (H.moveNum(fm[j]) === a) shared = true;
          }
        }
      }
    }
    if (!shared) return H.sayFail(ctx);
    user.expImprison = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSEALEDOPPONENTMOVE", { atk: user });
  },

  // Lua: setup.lua:142
  // pokefirered/src/battle_script_commands.c:9160
  snatch(ctx: EffectContext): void {
    if (moved_last(ctx)) return H.sayFail(ctx);
    ctx.user.expSnatch = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNWAITSFORTARGET", { atk: ctx.user });
  },

  // Lua: setup.lua:150
  // pokefirered/src/battle_script_commands.c:9316
  mudSport(ctx: EffectContext): void {
    if (truthy(ctx.user.mudSport)) return H.sayFail(ctx);
    ctx.user.mudSport = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_ELECTRICITYWEAKENED");
  },

  // Lua: setup.lua:157
  waterSport(ctx: EffectContext): void {
    if (truthy(ctx.user.waterSport)) return H.sayFail(ctx);
    ctx.user.waterSport = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_FIREWEAKENED");
  },

  // pokefirered/src/battle_script_commands.c:793
  // (Built on first read: see the port notes.)
  get TERRAIN_TYPE(): Record<number, any> {
    if (terrainType == null) {
      terrainType = {
        0: Types.ID.GRASS, 1: Types.ID.GRASS, 2: Types.ID.GROUND, 3: Types.ID.WATER,
        4: Types.ID.WATER, 5: Types.ID.WATER, 6: Types.ID.ROCK, 7: Types.ID.ROCK,
        8: Types.ID.NORMAL, 9: Types.ID.NORMAL,
      };
    }
    return terrainType;
  },
  set TERRAIN_TYPE(v: Record<number, any>) {
    terrainType = v;
  },

  // Lua: setup.lua:172
  // pokefirered/src/battle_script_commands.c:9389
  camouflage(ctx: EffectContext): void {
    const t = lor(Setup.TERRAIN_TYPE[Engine.terrainOf(ctx.adapter._st)], Types.ID.NORMAL);
    if (H.hasType(ctx, ctx.user, t)) return H.sayFail(ctx);
    ctx.user.type1 = t;
    ctx.user.type2 = t;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCHANGEDTYPE", { atk: ctx.user, buff1: Types.name(t) });
  },

  // Lua: setup.lua:183
  // pokefirered/src/battle_script_commands.c:8884
  rolePlay(ctx: EffectContext): void {
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    const foeAb = ctx.adapter.abilityOf(ctx.target);
    if (!truthy(foeAb) || foeAb === "WONDER_GUARD") return H.sayFail(ctx);
    ctx.user.expTracedAbility = foeAb;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCOPIEDFOE", { atk: ctx.user, def: ctx.target, defAbility: H.abilityId(foeAb) });
  },

  // Lua: setup.lua:193
  // pokefirered/src/battle_script_commands.c:8999
  skillSwap(ctx: EffectContext): void {
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    const a = ctx.adapter.abilityOf(ctx.user);
    const b = ctx.adapter.abilityOf(ctx.target);
    if ((!truthy(a) && !truthy(b)) || a === "WONDER_GUARD" || b === "WONDER_GUARD") return H.sayFail(ctx);
    ctx.user.expTracedAbility = b;
    ctx.target.expTracedAbility = a;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSWAPPEDABILITIES", { atk: ctx.user });
  },

  // Lua: setup.lua:205
  // pokefirered/src/battle_script_commands.c:8544
  futureSight(ctx: EffectContext): void {
    const ad = ctx.adapter;
    const side = ad.foeSide(ctx.user);
    if (!truthy(side)) return H.sayFail(ctx);
    side.tokens = truthy(side.tokens) ? side.tokens : [null];
    const double = truthy(ad._st) ? ad._st.double : ad._st;
    for (const [, tok] of ipairs(side.tokens)) {
      if (tok.id === "EXP_FUTURE_SIGHT" && (!truthy(double) || tok.targetId === ctx.target.id)) {
        return H.sayFail(ctx);
      }
    }
    const defSide = ad.ownSide(ctx.target);
    let dmg = Damage.base(ctx.user, ctx.target, lor(ctx.move, { power: 80, type: 14 }), {
      adapter: ad,
      weatherKind: Rules.weather.effective(ad._st, ad),
      reflect: truthy(defSide) ? lor(defSide.expReflectTurns, 0) > 0 : defSide,
      lightScreen: truthy(defSide) ? lor(defSide.expLightScreenTurns, 0) > 0 : defSide,
      doubleScreens: truthy(double) && truthy(ad._st)
        ? State.countPresentOnSide(ad._st, ctx.target.side) === 2
        : (truthy(double) ? ad._st : double),
    });
    // pokefirered/src/battle_script_commands.c:8558
    if (truthy(ctx.user.expHelpingHand)) dmg = Math.floor(dmg * 15 / 10);
    side.tokens[len(side.tokens) + 1] = {
      id: "EXP_FUTURE_SIGHT",
      turns: 3,
      damage: dmg,
      moveId: ctx.moveId,
      attackerSide: ctx.user.side,
      attackerId: ctx.user.id,
      targetId: ctx.target.id,
    };
    H.attackAnim(ctx);
    const tok = side.tokens[len(side.tokens)];
    if (H.moveNum(lor(ctx.move, ctx.moveId)) === 353) {
      tok.doomDesire = true;
      ad.sayText("STRINGID_PKMNCHOSEXASDESTINY", { atk: ctx.user, currentMove: 353 });
    } else {
      ad.sayText("STRINGID_PKMNFORESAWATTACK", { atk: ctx.user });
    }
  },

  // Lua: setup.lua:248
  // pokefirered/data/battle_scripts_1.s:1478
  curse(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    if (H.hasType(ctx, user, Types.ID.GHOST)) {
      let t = ctx.target;
      if (t === user) { t = ad.foeOf(user); ctx.target = t; }
      if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
      if (!truthy(H.accuracy(ctx, "lockon"))) return;
      if (truthy(t.expCursed)) return H.sayFail(ctx);
      t.expCursed = true;
      t.cursed = true;
      let cost = Math.floor(ad.maxHp(user) / 2);
      if (cost === 0) cost = 1;
      H.attackAnim(ctx);
      ad.applyHpLoss(user, cost);
      ad.sayText("STRINGID_PKMNLAIDCURSE", { atk: user, def: t });
      const M = H.move(ctx);
      if (truthy(M)) M.checkUserFaint = true;
      return;
    }
    const s = user.stages;
    if (lor(s.speed, 0) <= -6 && lor(s.attack, 0) >= 6 && lor(s.defense, 0) >= 6) {
      return H.sayFail(ctx);
    }
    H.attackAnim(ctx);
    Secondary.changeStat(ad, user, "speed", -1, { user: true, allowPtr: true, curse: true, noAnim: true, noMsg: lor(s.speed, 0) <= -6 });
    Secondary.changeStat(ad, user, "attack", 1, { user: true, allowPtr: true, noAnim: true, noMsg: lor(s.attack, 0) >= 6 });
    Secondary.changeStat(ad, user, "defense", 1, { user: true, allowPtr: true, noAnim: true, noMsg: lor(s.defense, 0) >= 6 });
  },

  // Lua: setup.lua:278
  // pokefirered/data/battle_scripts_1.s:1690
  batonPass(ctx: EffectContext): any {
    return Special.batonPass(ctx);
  },

  // Lua: setup.lua:284
  // pokefirered/src/battle_script_commands.c:8779
  helpingHand(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const st = ad._st;
    const pid = State.PARTNER(State.idOf(user) as number);
    const partner = State.battler(st, pid);
    if (!(truthy(st) && truthy(st.double)) || !truthy(State.isPresent(st, pid)) || !truthy(partner)
        || truthy(user.expHelpingHand) || truthy(partner.expHelpingHand)) {
      return H.sayFail(ctx);
    }
    partner.expHelpingHand = true;
    ctx.target = partner;
    const M = H.move(ctx);
    if (truthy(M)) {
      M.target = partner;
      M.tname = ad.displayName(partner);
    }
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNREADYTOHELP", { atk: user, def: partner });
  },

  // Lua: setup.lua:305
  splash(ctx: EffectContext): void {
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_BUTNOTHINGHAPPENED");
  },

  // Lua: setup.lua:311
  // pokefirered/data/battle_scripts_1.s:902
  confuse(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (ad.abilityOf(t) === "OWN_TEMPO") {
      return ad.sayText("STRINGID_PKMNPREVENTSCONFUSIONWITH", { def: t, defAbility: H.abilityId("OWN_TEMPO") });
    }
    if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (lor(t.confusionTurns, 0) > 0) {
      return ad.sayText("STRINGID_PKMNALREADYCONFUSED", { def: t });
    }
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (Status.safeguarded(ctx)) return;
    H.attackAnim(ctx);
    const M = lor(H.move(ctx), { adapter: ad, user: ctx.user, target: t, st: ad._st });
    Secondary.set(M, "CONFUSION", true, false, false);
  },

  // Lua: setup.lua:329
  // pokefirered/src/battle_script_commands.c:6826
  haze(ctx: EffectContext): void {
    H.attackAnim(ctx);
    for (const [, b] of ipairs(ctx.adapter.activeBattlers())) {
      if (truthy(b) && truthy(b.stages)) {
        for (const [k] of pairs(b.stages)) b.stages[k] = 0;
      }
    }
    ctx.adapter.sayText("STRINGID_STATCHANGESGONE");
  },

  // Lua: setup.lua:340
  // pokefirered/src/battle_script_commands.c:7442
  substitute(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user;
    if (lor(user.substituteHP, 0) > 0) {
      return ad.sayText("STRINGID_PKMNHASSUBSTITUTE", { atk: user });
    }
    const maxHp = ad.maxHp(user);
    let cost = Math.floor(maxHp / 4);
    if (cost === 0) cost = 1;
    if (ad.hp(user) <= cost) {
      const M = H.move(ctx);
      if (truthy(M)) M.failed = true;
      return ad.sayText("STRINGID_TOOWEAKFORSUBSTITUTE");
    }
    user.substituteHP = cost;
    user.expTrapTurns = null;
    user.wrapped = null;
    H.attackAnim(ctx);
    ad.applyHpLoss(user, cost);
    ad.sayText("STRINGID_PKMNMADESUBSTITUTE", { atk: user });
  },

  // Lua: setup.lua:362
  // pokefirered/data/battle_scripts_1.s:2566
  teeterDance(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (ad.abilityOf(t) === "OWN_TEMPO") {
      return ad.sayText("STRINGID_PKMNPREVENTSCONFUSIONWITH", { def: t, defAbility: H.abilityId("OWN_TEMPO") });
    }
    if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (lor(t.confusionTurns, 0) > 0) {
      return ad.sayText("STRINGID_PKMNALREADYCONFUSED", { def: t });
    }
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    const side = ad.ownSide(t);
    if (truthy(side) && lor(side.expSafeguardTurns, 0) > 0) {
      return ad.sayText("STRINGID_PKMNUSEDSAFEGUARD", { def: t });
    }
    H.attackAnim(ctx);
    const M = lor(H.move(ctx), { adapter: ad, user: ctx.user, target: t, st: ad._st });
    Secondary.set(M, "CONFUSION", true, false, false);
  },
};

export default Setup;
