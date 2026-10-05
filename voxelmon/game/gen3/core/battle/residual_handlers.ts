// Port of gen1recomp src/core/game3/battle/residual_handlers.lua (GPLv3 + additional terms; see LICENSE.md).
// Owned residual handlers (game3 owns status/weather/volatiles — not host).
//
// Port notes:
// - The lazy requires (state, abilities, held_items, engine, effects._helpers,
//   effects.hit, moves) are static imports;
//   `package.loaded["src.core.game3.battle.rules"] or Rules` is Rules.
// - Handlers.wishDoubles is assigned inside registerAll, as in the Lua
//   (residual_handlers.lua:175), so it exists once registerAll has run.
// - Adapter and move-context colon calls are method calls on those objects.
// - Callee tuples used here: Hit.adjustDamage -> [dmg, hung].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../../platform/lt.ts";
import Residuals from "./residuals.ts";
import Rules from "./rules.ts";
import StatusChip from "./status.ts";
import Moves from "./moves.ts";
import State from "./state.ts";
import Abilities from "./abilities.ts";
import HeldItems from "./held_items.ts";
import Engine from "./engine.ts";
import H from "./effects/_helpers.ts";
import Hit from "./effects/hit.ts";

export interface HandlersModule {
  _installed: boolean;
  tickWeather(ad: any): void;
  registerAll(): void;
  wishDoubles?: (ad: any) => void;
  futureSightDoubles(ad: any): void;
  futureSightHit(ad: any, tok: any, target: any): void;
}

export const Handlers = {} as HandlersModule;
Handlers._installed = false;

const SIDE_KEYS = seq("player", "enemy");

// Lua: residual_handlers.lua:11
function side_battler(ad: any, sideKey: any): any {
  const st = ad._st;
  return sideKey === "player" ? st.player : st.enemy;
}

// Lua: residual_handlers.lua:16
function slot_battler(ad: any, id: any): any {
  if (id == null || !State.isPresent(ad._st, id)) return null;
  return State.battler(ad._st, id);
}

// Lua: residual_handlers.lua:22
function token_battler(ad: any, key: string, tok: any, field: string): any {
  if (truthy(ad._st.double) && tok[field] != null) return slot_battler(ad, tok[field]);
  return side_battler(ad, key);
}

// Lua: residual_handlers.lua:28 -- data/battle_scripts_1.s:3533
function wish_heal(ad: any, tok: any, b: any): void {
  // src/battle_script_commands.c:8916
  ad.sayText("STRINGID_PKMNWISHCAMETRUE", { buff1: State.prefixedName(ad._st, b, tok.wisher) });
  if (ad.hp(b) >= ad.maxHp(b)) {
    ad.sayText("STRINGID_PKMNHPFULL", { def: b });
  } else {
    let heal = Math.floor(ad.maxHp(b) / 2);
    if (heal === 0) heal = 1;
    ad.heal(b, heal);
    ad.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: b });
  }
}

// Lua: residual_handlers.lua:43 -- pokefirered/src/battle_util.c:505
function side_timer(field: string, move: number): (ctx: any) => void {
  return function (ctx: any): void {
    const ad = ctx.adapter;
    for (const [, key] of ipairs<string>(SIDE_KEYS)) {
      const side = key === "player" ? ad._st.playerSide : ad._st.enemySide;
      if (truthy(side) && (side[field] ?? 0) > 0) {
        side[field] = side[field] - 1;
        if (side[field] <= 0) {
          side[field] = null;
          if (field === "expSafeguardTurns") {
            ad.sayText("STRINGID_PKMNSAFEGUARDEXPIRED", { atk: key });
          } else {
            ad.sayText("STRINGID_PKMNSXWOREOFF", { atk: key, buff1: Moves.displayName(move) });
          }
        }
      }
    }
  };
}

// Lua: residual_handlers.lua:64 -- pokefirered/src/battle_util.c:624
Handlers.tickWeather = function (ad: any): void {
  const st = ad._st;
  const kind = Rules.weather.kind(st.weather);
  if (!truthy(kind)) return;
  const turns = tonumber(st.weatherTurns) ?? 0;
  let ended = false;
  if (turns > 0) {
    st.weatherTurns = turns - 1;
    ended = st.weatherTurns <= 0;
  }
  if (kind === "RAIN") {
    if (ended) {
      ad.sayText("STRINGID_RAINSTOPPED");
      st.weather = null;
    } else {
      ad.sayText("STRINGID_RAINCONTINUES");
      ad.playAnim("general", "RAIN_CONTINUES", null, null);
    }
    return;
  }
  if (kind === "SUN") {
    if (ended) {
      ad.sayText("STRINGID_SUNLIGHTFADED");
      st.weather = null;
    } else {
      ad.sayText("STRINGID_SUNLIGHTSTRONG");
      ad.playAnim("general", "SUN_CONTINUES", null, null);
    }
    return;
  }
  if (ended) {
    ad.sayText(kind === "SAND" ? "STRINGID_SANDSTORMSUBSIDED" : "STRINGID_HAILSTOPPED");
    st.weather = null;
    return;
  }
  ad.sayText(kind === "SAND" ? "STRINGID_SANDSTORMRAGES" : "STRINGID_HAILCONTINUES");
  ad.playAnim("general", kind === "SAND" ? "SANDSTORM_CONTINUES" : "HAIL_CONTINUES", null, null);
  if (!truthy(Rules.weather.effective(st, ad))) return;
  const order = Residuals.sortedBattlers(ad);
  for (const [, b] of ipairs(order)) {
    if (!truthy(ad.isFainted(b))) {
      let immune: any;
      const semiHidden = b.semiInvulnerable === "UNDERGROUND" || b.semiInvulnerable === "UNDERWATER";
      if (kind === "SAND") {
        immune = truthy(ad.hasType(b, 5)) || truthy(ad.hasType(b, 8)) || truthy(ad.hasType(b, 4))
          || ad.abilityOf(b) === "SAND_VEIL" || semiHidden;
      } else {
        immune = truthy(ad.hasType(b, 15)) || semiHidden;
      }
      // pokefirered/src/battle_script_commands.c:7218
      if (truthy(st.ghostBattle) && !truthy(st.ghostUnveiled) && b.side === "enemy") immune = true;
      if (!immune) {
        // pokefirered/src/battle_script_commands.c:7216
        const dmg = Rules.weather.chipAmount(ad.maxHp(b));
        if (kind === "SAND") {
          ad.sayText("STRINGID_PKMNBUFFETEDBYSANDSTORM", { atk: b });
        } else {
          ad.sayText("STRINGID_PKMNPELTEDBYHAIL", { atk: b });
        }
        ad.applyHpLoss(b, dmg);
        if (truthy(ad.isFainted(b))) {
          b._faintAnnounced = true;
          ad.pushEvent({ kind: "faint", side: b.side, battler: b.id });
          ad.sayText("STRINGID_ATTACKERFAINTED", { atk: b });
          ad.emitFaint(b);
        }
      }
    }
  }
};

// Lua: residual_handlers.lua:135
Handlers.registerAll = function (): void {
  if (Handlers._installed) return;
  Handlers._installed = true;

  // src/battle_util.c:516
  Residuals.register("reflect", side_timer("expReflectTurns", 115));
  Residuals.register("light_screen", side_timer("expLightScreenTurns", 113));
  Residuals.register("mist", side_timer("expMistTurns", 54));
  Residuals.register("safeguard", side_timer("expSafeguardTurns", 219));

  // Lua: residual_handlers.lua:146 -- pokefirered/src/battle_util.c:603
  Residuals.register("wish", function (ctx: any): any {
    const ad = ctx.adapter;
    if (truthy(ad._st.double)) return Handlers.wishDoubles!(ad);
    for (const [, key] of ipairs<string>(SIDE_KEYS)) {
      const side = key === "player" ? ad._st.playerSide : ad._st.enemySide;
      if (truthy(side) && truthy(side.tokens)) {
        const keep: LuaTable = seq();
        for (const [, tok] of ipairs(side.tokens)) {
          if (tok.id === "EXP_WISH") {
            tok.turns = (tok.turns ?? 1) - 1;
            const b = side_battler(ad, key);
            if (tok.turns <= 0) {
              if (truthy(b) && ad.hp(b) > 0) {
                ad.playAnim("general", "WISH_HEAL", b, b);
                wish_heal(ad, tok, b);
              }
            } else {
              keep[len(keep) + 1] = tok;
            }
          } else {
            keep[len(keep) + 1] = tok;
          }
        }
        side.tokens = keep;
      }
    }
  });

  // Lua: residual_handlers.lua:175 -- pokefirered/src/battle_util.c:603
  Handlers.wishDoubles = function (ad: any): void {
    const st = ad._st;
    for (const [, b0] of ipairs(Residuals.sortedBattlers(ad))) {
      const id = b0.id;
      const side = (mod(id, 2) === 0) ? st.playerSide : st.enemySide;
      if (truthy(side) && truthy(side.tokens)) {
        const keep: LuaTable = seq();
        for (const [, tok] of ipairs(side.tokens)) {
          if (tok.id === "EXP_WISH" && (tok.battlerId == null || tok.battlerId === id)) {
            tok.turns = (tok.turns ?? 1) - 1;
            if (tok.turns <= 0) {
              const b = slot_battler(ad, id);
              if (truthy(b) && ad.hp(b) > 0) {
                ad.playAnim("general", "WISH_HEAL", b, b);
                wish_heal(ad, tok, b);
              }
            } else {
              keep[len(keep) + 1] = tok;
            }
          } else {
            keep[len(keep) + 1] = tok;
          }
        }
        side.tokens = keep;
      }
    }
  };

  // Lua: residual_handlers.lua:203
  Residuals.register("weather_continue", function (ctx: any): void {
    Handlers.tickWeather(ctx.adapter);
  });

  // Lua: residual_handlers.lua:208 -- pokefirered/src/battle_util.c:760
  Residuals.register("ingrain", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expIngrain)) return;
    const maxHp = ad.maxHp(b), cur = ad.hp(b);
    if (cur <= 0 || cur >= maxHp) return;
    let heal = Math.floor(maxHp / 16);
    if (heal === 0) heal = 1;
    ad.playAnim("general", "INGRAIN_HEAL", b, b);
    ad.sayText("STRINGID_PKMNABSORBEDNUTRIENTS", { atk: b });
    ad.heal(b, heal);
  });

  // Lua: residual_handlers.lua:221 -- pokefirered/src/battle_util.c:774
  Residuals.register("abilities_eot", function (ctx: any): void {
    Abilities.endTurn(ctx.adapter, ctx.target);
  });

  // Lua: residual_handlers.lua:227 -- pokefirered/src/battle_util.c:779
  Residuals.register("held_items", function (ctx: any): void {
    HeldItems.normal(ctx.adapter, ctx.target, false);
  });

  // Lua: residual_handlers.lua:233 -- pokefirered/src/battle_util.c:1208
  Residuals.register("fainted_actions", function (ctx: any): void {
    Engine.afterAction(ctx.adapter._st, ctx.adapter);
  });

  // Lua: residual_handlers.lua:239 -- pokefirered/src/battle_util.c:789
  Residuals.register("leech_seed", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expSeeded)) return;
    let src = b.expSeedSource;
    if (truthy(src) && truthy(ad._st.double)) {
      src = slot_battler(ad, src.id);
    } else if (truthy(src) && truthy(src.side)) {
      src = side_battler(ad, src.side);
    }
    if (!truthy(src) || truthy(ad.isFainted(src)) || truthy(ad.isFainted(b))) return;
    let dmg = Math.floor(ad.maxHp(b) / 8);
    if (dmg === 0) dmg = 1;
    ad.playAnim("general", "LEECH_SEED_DRAIN", b, src);
    const dealt = ad.applyHpLoss(b, dmg);
    if (ad.abilityOf(b) === "LIQUID_OOZE") {
      ad.applyHpLoss(src, dealt);
      ad.sayText("STRINGID_ITSUCKEDLIQUIDOOZE");
    } else {
      ad.heal(src, dealt);
      ad.sayText("STRINGID_PKMNSAPPEDBYLEECHSEED", { atk: b });
    }
  });

  // Lua: residual_handlers.lua:262
  Residuals.register("status_chip", function (ctx: any): void {
    const b = ctx.target;
    if (!truthy(b)) return;
    StatusChip.tickChip(b, ctx.adapter);
  });

  // Lua: residual_handlers.lua:269 -- pokefirered/src/battle_util.c:841
  Residuals.register("nightmare", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expNightmare) || ad.hp(b) <= 0) return;
    if (!truthy(ad.hasStatus(b, "SLP"))) {
      b.expNightmare = null;
      return;
    }
    let dmg = Math.floor(ad.maxHp(b) / 4);
    if (dmg === 0) dmg = 1;
    ad.sayText("STRINGID_PKMNLOCKEDINNIGHTMARE", { atk: b });
    ad.playAnim("status", "NIGHTMARE", b, b);
    ad.applyHpLoss(b, dmg);
  });

  // Lua: residual_handlers.lua:284 -- pokefirered/src/battle_util.c:861
  Residuals.register("curse", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expCursed) || ad.hp(b) <= 0) return;
    let dmg = Math.floor(ad.maxHp(b) / 4);
    if (dmg === 0) dmg = 1;
    ad.sayText("STRINGID_PKMNAFFLICTEDBYCURSE", { atk: b });
    ad.playAnim("status", "CURSED", b, b);
    ad.applyHpLoss(b, dmg);
  });

  // Lua: residual_handlers.lua:295 -- pokefirered/src/battle_util.c:872
  Residuals.register("partial_trap_chip", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expTrapTurns) || ad.hp(b) <= 0) return;
    // package.loaded["src.core.game3.battle.rules"] or Rules
    const R: any = Rules;
    if (truthy(R.partialTrap) && truthy(R.partialTrap.active) && !truthy(R.partialTrap.active())) return;
    b.expTrapTurns = b.expTrapTurns - 1;
    // src/battle_util.c:882
    const moveName = Moves.displayName(b.expTrapMove);
    if (b.expTrapTurns > 0) {
      ad.playAnim("general", "TURN_TRAP", b, b, b.expTrapMove);
      ad.sayText("STRINGID_PKMNHURTBY", { atk: b, buff1: moveName });
      let chip: any = (truthy(R.partialTrap) && truthy(R.partialTrap.chipAmount))
        ? R.partialTrap.chipAmount(ad.maxHp(b)) : null;
      if (!truthy(chip)) chip = Math.max(1, Math.floor(ad.maxHp(b) / 16));
      ad.applyHpLoss(b, chip);
    } else {
      b.expTrapTurns = null;
      b.expTrapMove = null;
      b.expTrapSource = null;
      b.wrapped = null;
      ad.sayText("STRINGID_PKMNFREEDFROM", { atk: b, buff1: moveName });
    }
  });

  // Lua: residual_handlers.lua:318 -- pokefirered/src/battle_util.c:904
  Residuals.register("uproar", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || (b.expUproarTurns ?? 0) <= 0) return;
    for (const [, other] of ipairs(ad.activeBattlers())) {
      if (truthy(ad.hasStatus(other, "SLP")) && ad.abilityOf(other) !== "SOUNDPROOF") {
        ad.clearStatus(other);
        other.expNightmare = null;
        ad.sayText("STRINGID_PKMNWOKEUPINUPROAR", { atk: other });
      }
    }
    b.expUproarTurns = b.expUproarTurns - 1;
    if (truthy(b.expUnableToMove)) {
      Engine.cancelMultiTurnMoves(b);
      ad.sayText("STRINGID_PKMNCALMEDDOWN", { atk: b });
    } else if (b.expUproarTurns > 0) {
      ad.sayText("STRINGID_PKMNMAKINGUPROAR", { atk: b });
    } else {
      Engine.cancelMultiTurnMoves(b);
      ad.sayText("STRINGID_PKMNCALMEDDOWN", { atk: b });
    }
  });

  // Lua: residual_handlers.lua:342 -- pokefirered/src/battle_util.c:953
  Residuals.register("thrash", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || (b.expRampageTurns ?? 0) <= 0) return;
    b.expRampageTurns = b.expRampageTurns - 1;
    if (truthy(b.expUnableToMove)) {
      Engine.cancelMultiTurnMoves(b);
    } else if (b.expRampageTurns <= 0 && truthy(b.expLockedMove)) {
      b.expLockedMove = null;
      b.expLockedSlot = null;
      b.expRampageTurns = null;
      if ((b.confusionTurns ?? 0) <= 0 && ad.abilityOf(b) !== "OWN_TEMPO") {
        b.confusionTurns = mod(ad.roll(0, 3), 4) + 2;
        ad.playAnim("status", "CONFUSION", b, b);
        ad.sayText("STRINGID_PKMNFATIGUECONFUSION", { atk: b });
      }
    }
  });

  // Lua: residual_handlers.lua:362 -- pokefirered/src/battle_util.c:975
  Residuals.register("disable", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || !truthy(b.expDisabledMove)) return;
    let known = false;
    const mon = truthy(b.mon) ? b.mon : {};
    for (let i = 1; i <= 4; i++) {
      if (H.moveNum(truthy(mon.moves) ? mon.moves[i] : mon.moves) === b.expDisabledMove) known = true;
    }
    if (!known) {
      b.expDisabledMove = null; b.expDisableTurns = null; b.disabled = null;
      return;
    }
    b.expDisableTurns = (b.expDisableTurns ?? 1) - 1;
    if (b.expDisableTurns <= 0) {
      b.expDisabledMove = null; b.expDisableTurns = null; b.disabled = null;
      ad.sayText("STRINGID_PKMNMOVEDISABLEDNOMORE", { atk: b });
    }
  });

  // Lua: residual_handlers.lua:383 -- pokefirered/src/battle_util.c:998
  Residuals.register("encore", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || (b.expEncoreTurns ?? 0) <= 0) return;
    const mon = truthy(b.mon) ? b.mon : {};
    const slot = truthy(b.expEncoreSlot) ? b.expEncoreSlot : H.slotOf(b, b.expEncoreMove);
    if (!truthy(slot) || H.moveNum(truthy(mon.moves) ? mon.moves[slot] : mon.moves) !== H.moveNum(b.expEncoreMove)) {
      b.expEncoreMove = null; b.expEncoreTurns = null; b.expEncoreSlot = null;
      return;
    }
    b.expEncoreTurns = b.expEncoreTurns - 1;
    if (b.expEncoreTurns <= 0 || (tonumber(truthy(mon.pp) ? mon.pp[slot] : mon.pp) ?? 0) <= 0) {
      b.expEncoreMove = null; b.expEncoreTurns = null; b.expEncoreSlot = null;
      ad.sayText("STRINGID_PKMNENCOREENDED", { atk: b });
    }
  });

  // Lua: residual_handlers.lua:400
  Residuals.register("lock_on", function (ctx: any): void {
    const b = ctx.target;
    if (truthy(b) && tonumber(b.expLockedOn) != null && b.expLockedOn > 0) {
      b.expLockedOn = b.expLockedOn - 1;
      if (b.expLockedOn <= 0) { b.expLockedOn = null; b.expLockedOnBy = null; }
    } else if (truthy(b) && b.expLockedOn === true) {
      b.expLockedOn = 1;
    }
  });

  // Lua: residual_handlers.lua:410
  Residuals.register("charge", function (ctx: any): void {
    const b = ctx.target;
    if (truthy(b) && tonumber(b.expCharged) != null) {
      b.expCharged = b.expCharged - 1;
      if (b.expCharged <= 0) { b.expCharged = null; b.chargedUp = null; }
    }
  });

  // Lua: residual_handlers.lua:418
  Residuals.register("taunt", function (ctx: any): void {
    const b = ctx.target;
    if (truthy(b) && (b.expTauntedTurns ?? 0) > 0) {
      b.expTauntedTurns = b.expTauntedTurns - 1;
      if (b.expTauntedTurns <= 0) b.expTauntedTurns = null;
    }
  });

  // Lua: residual_handlers.lua:427 -- pokefirered/src/battle_util.c:1032
  Residuals.register("yawn", function (ctx: any): void {
    const ad = ctx.adapter, b = ctx.target;
    if (!truthy(b) || (b.expYawnTurns ?? 0) <= 0) return;
    b.expYawnTurns = b.expYawnTurns - 1;
    b.yawnTurns = b.expYawnTurns > 0 ? b.expYawnTurns : null;
    if (b.expYawnTurns > 0) return;
    b.expYawnTurns = null;
    const ab = ad.abilityOf(b);
    if (truthy(ad.status(b)) || ab === "VITAL_SPIRIT" || ab === "INSOMNIA") return;
    if (truthy(ad.uproarActive()) && ab !== "SOUNDPROOF") return;
    Engine.cancelMultiTurnMoves(b);
    ad.applyStatus(b, "SLP", b, { force: true, ignoreSafeguard: true });
    ad.statusAnim(b, "SLP");
    ad.sayText("STRINGID_PKMNFELLASLEEP", { eff: b });
  });

  // Lua: residual_handlers.lua:444
  Residuals.register("volatiles", function (ctx: any): void {
    const b = ctx.target;
    if (!truthy(b)) return;
    b.expJustEntered = null;
    b.expUnableToMove = null;
  });

  // Lua: residual_handlers.lua:452 -- pokefirered/src/battle_util.c:1081
  Residuals.register("future_sight", function (ctx: any): any {
    const ad = ctx.adapter;
    if (truthy(ad._st.double)) return Handlers.futureSightDoubles(ad);
    for (const [, key] of ipairs<string>(SIDE_KEYS)) {
      const side = key === "player" ? ad._st.playerSide : ad._st.enemySide;
      if (truthy(side) && truthy(side.tokens)) {
        const keep: LuaTable = seq();
        for (const [, tok] of ipairs(side.tokens)) {
          const target = token_battler(ad, key, tok, "targetId");
          if (tok.id === "EXP_FUTURE_SIGHT") {
            tok.turns = (tok.turns ?? 1) - 1;
            if (tok.turns <= 0) {
              if (truthy(target) && ad.hp(target) > 0) {
                Handlers.futureSightHit(ad, tok, target);
              }
            } else {
              keep[len(keep) + 1] = tok;
            }
          } else {
            keep[len(keep) + 1] = tok;
          }
        }
        side.tokens = keep;
      }
    }
  });

  // Lua: residual_handlers.lua:480 -- pokefirered/src/battle_util.c:1116
  Residuals.register("perish_song", function (ctx: any): void {
    const ad = ctx.adapter;
    for (const [, b] of ipairs(Residuals.sortedBattlers(ad))) {
      if (truthy(b.expPerishTurns) && ad.hp(b) > 0) {
        const n = b.expPerishTurns;
        // src/battle_util.c:1118
        ad.sayText("STRINGID_PKMNPERISHCOUNTFELL", { atk: b, buff1: tostring(n) });
        if (n <= 0) {
          b.expPerishTurns = null;
          b.perishSong = null;
          ad.applyHpLoss(b, ad.hp(b));
        } else {
          b.expPerishTurns = n - 1;
        }
      }
    }
  });
};

// Lua: residual_handlers.lua:500 -- pokefirered/src/battle_util.c:1081
Handlers.futureSightDoubles = function (ad: any): void {
  const st = ad._st;
  for (const [, id] of ipairs<number>(State.battlerOrder(st))) {
    const side = (mod(id, 2) === 0) ? st.playerSide : st.enemySide;
    if (truthy(side) && truthy(side.tokens)) {
      const keep: LuaTable = seq();
      for (const [, tok] of ipairs(side.tokens)) {
        const tid = tok.targetId ?? ((mod(id, 2) === 0) ? 0 : 1);
        if (tok.id === "EXP_FUTURE_SIGHT" && tid === id) {
          tok.turns = (tok.turns ?? 1) - 1;
          if (tok.turns <= 0) {
            const target = slot_battler(ad, id);
            if (truthy(target) && ad.hp(target) > 0) Handlers.futureSightHit(ad, tok, target);
          } else {
            keep[len(keep) + 1] = tok;
          }
        } else {
          keep[len(keep) + 1] = tok;
        }
      }
      side.tokens = keep;
    }
  }
};

// Lua: residual_handlers.lua:526 -- pokefirered/data/battle_scripts_1.s:3461
Handlers.futureSightHit = function (ad: any, tok: any, target: any): void {
  let attacker = side_battler(ad, truthy(tok.attackerSide) ? tok.attackerSide : (target.side === "player" ? "enemy" : "player"));
  if (truthy(ad._st.double) && tok.attackerId != null) {
    const a2 = State.battler(ad._st, tok.attackerId);
    attacker = truthy(a2) ? a2 : attacker;
  }
  const moveId = truthy(tok.moveId) ? tok.moveId : 248;
  ad.sayText("STRINGID_PKMNTOOKATTACK", { def: target, buff1: Moves.displayName(moveId) });
  const anim = { moveId: tok.moveId, user: attacker, target: target, hits: seq(), heals: seq(), faints: seq() };
  const M = Engine.newContext(attacker, target, moveId, null, ad, ad._st, {}, anim, { futureSight: true });
  M.accOverride = tonumber(Moves.get(moveId).accuracy) ?? 90;
  if (!truthy(M.accuracyCheck("normal", false))) {
    ad.sayFail();
    return;
  }
  let dmg = tonumber(tok.damage) ?? 1;
  const r = ad.roll(85, 100);
  dmg = Math.floor(dmg * r / 100);
  if (dmg === 0) dmg = 1;
  let hung: any;
  [dmg, hung] = Hit.adjustDamage(M, target, dmg);
  ad.playAnim("general", truthy(tok.doomDesire) ? "DOOM_DESIRE_HIT" : "FUTURE_SIGHT_HIT", attacker, target);
  Hit.dealDamage(M, dmg, { physical: false });
  if (hung === "endured") {
    ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
  } else if (hung === "hung") {
    HeldItems.focusBandMessage(ad, target);
  }
};

export default Handlers;
