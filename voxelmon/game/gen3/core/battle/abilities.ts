// Port of gen1recomp src/core/game3/battle/abilities.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle abilities: weather setters, Forecast, Intimidate, Trace, end-of-turn
// abilities, absorb / contact / status abilities, escape blockers.
//
// Port notes:
// - The lazy requires (adapter, pokemon, state) are static imports;
//   `pcall(require, "src.core.game3.pokemon")` always succeeds here, and
//   `pcall(Pokemon.gender, ...)` is a try/catch.
// - Adapter and move-context colon calls (`ad:abilityOf(b)`,
//   `M:attackString()`) are method calls on those objects.
// - Multiple returns are 0-based tuples: escapeBlocker -> [blocker, ability]
//   or [null].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq } from "../../platform/lt.ts";
import Rules from "./rules.ts";
import Types from "./types.ts";
import Secondary from "./effects/secondary.ts";
import { RomText } from "../rom_text.ts";
import State from "./state.ts";
import Adapter from "./adapter.ts";
import { Pokemon } from "../pokemon.ts";

export interface AbilitiesModule {
  id(ab: any): number;
  name(ab: any): string;
  SOUND_MOVES: Record<number, boolean>;
  genderOf(b: any): string;
  castformChange(ad: any, b: any): number;
  forecast(ad: any): boolean;
  ghostBlocks(st: any, ab: any): boolean;
  switchIn(ad: any, b: any): boolean;
  runIntimidate(ad: any): boolean;
  runTrace(ad: any): boolean;
  endTurn(ad: any, b: any): boolean;
  truantLoafs(ad: any, b: any): boolean;
  soundproofBlocks(M: any): boolean;
  absorb(M: any): boolean;
  applyStatus(ad: any, holder: any, victim: any, status: any, primary: any, M?: any): boolean;
  onDamage(M: any): boolean;
  immunityCure(ad: any): boolean;
  synchronize(M: any, holder: any, victim: any): boolean;
  escapeBlocker(ad: any, b: any): [any, string?];
  switchOut(ad: any, b: any): boolean;
}

export const Abilities = {} as AbilitiesModule;

let ID_BY_NAME: Record<string, number> | null = null;

// Lua: abilities.lua:10
Abilities.id = function (ab: any): number {
  if (!truthy(ID_BY_NAME)) {
    ID_BY_NAME = Object.create(null) as Record<string, number>;
    for (const [id, key] of pairs<string>(Adapter.ABILITY_BY_ID)) ID_BY_NAME[key] = id as number;
  }
  const v = ID_BY_NAME![ab];
  if (!truthy(v)) throw new Error("unknown ability " + tostring(ab));
  return v as number;
};

// Lua: abilities.lua:18
Abilities.name = function (ab: any): string {
  return Pokemon.abilityName(Abilities.id(ab));
};

// Lua: abilities.lua:22
function say_id(ad: any, id: string, fill?: any): void {
  ad.sayText(id, fill);
}

// src/battle_main.c:601
const STATUS_WORD: Record<string, string> = {
  PSN: "gText_Poison", TOX: "gText_Poison", SLP: "gText_Sleep", PAR: "gText_Paralysis",
  BRN: "gText_Burn", FRZ: "gText_Ice",
};

// pokefirered/src/battle_util.c:31
const SOUND_MOVES: Record<number, boolean> = {
  45: true, 46: true, 47: true, 48: true, 103: true, 173: true,
  253: true, 319: true, 320: true, 304: true,
};
Abilities.SOUND_MOVES = SOUND_MOVES;

const SPECIES_CASTFORM = 385;

// Lua: abilities.lua:39
function ab_id(ad: any, b: any): number { return Abilities.id(ad.abilityOf(b)); }

// Lua: abilities.lua:41
function is_type(b: any, t: any): boolean {
  if (!truthy(b)) return false;
  return b.type1 === t || b.type2 === t;
}

// Lua: abilities.lua:46
function set_type(b: any, t: any): void {
  b.type1 = t;
  b.type2 = null;
}

// Lua: abilities.lua:51
function gender_of(b: any): string {
  const mon = truthy(b) ? b.mon : b;
  if (!truthy(mon)) return "U";
  const g = mon.gender;
  if (g === "M" || g === "F" || g === "U") return g;
  // pcall(require, "src.core.game3.pokemon") -- always loads here
  if (truthy(Pokemon) && truthy(Pokemon.gender)) {
    let ok2 = false, gg: any;
    try {
      gg = Pokemon.gender(truthy(b.species) ? b.species : mon.species, mon.personality);
      ok2 = true;
    } catch {
      ok2 = false;
    }
    if (ok2 && truthy(gg)) return gg;
  }
  return "U";
}
Abilities.genderOf = gender_of;

// Lua: abilities.lua:65
function weather_active(ad: any): string | null {
  return Rules.weather.effective(ad._st, ad);
}

// Lua: abilities.lua:69
function weather_permanent(st: any, kind: string): boolean {
  return Rules.weather.kind(st.weather) === kind && (tonumber(st.weatherTurns) ?? 0) <= 0;
}

// Lua: abilities.lua:74 -- pokefirered/src/battle_util.c:1611
Abilities.castformChange = function (ad: any, b: any): number {
  if (!truthy(b) || tonumber(b.species) !== SPECIES_CASTFORM || ad.abilityOf(b) !== "FORECAST" || ad.hp(b) <= 0) {
    return 0;
  }
  const w = weather_active(ad);
  if (!truthy(w) && !is_type(b, Types.ID.NORMAL)) {
    set_type(b, Types.ID.NORMAL);
    return 1;
  }
  if (!truthy(w)) return 0;
  let form = 0;
  if (w !== "RAIN" && w !== "SUN" && w !== "HAIL" && !is_type(b, Types.ID.NORMAL)) {
    set_type(b, Types.ID.NORMAL); form = 1;
  }
  if (w === "SUN" && !is_type(b, Types.ID.FIRE)) { set_type(b, Types.ID.FIRE); form = 2; }
  if (w === "RAIN" && !is_type(b, Types.ID.WATER)) { set_type(b, Types.ID.WATER); form = 3; }
  if (w === "HAIL" && !is_type(b, Types.ID.ICE)) { set_type(b, Types.ID.ICE); form = 4; }
  return form;
};

// Lua: abilities.lua:95 -- pokefirered/data/battle_scripts_1.s:3972
function castform_script(ad: any, b: any, form: number): void {
  b.expCastformForm = form - 1;
  // pokefirered/src/battle_script_commands.c:9293
  const arg = ((b.substituteHP ?? 0) > 0) ? (form - 1 + 128) : (form - 1);
  ad.playAnim("general", "CASTFORM_CHANGE", b, b, arg);
  say_id(ad, "STRINGID_PKMNTRANSFORMED", { scrActive: b });
}

// Lua: abilities.lua:104 -- pokefirered/src/battle_util.c:2169
Abilities.forecast = function (ad: any): boolean {
  for (const [, b] of ipairs(ad.activeBattlers())) {
    if (ad.abilityOf(b) === "FORECAST") {
      const form = Abilities.castformChange(ad, b);
      if (form !== 0) {
        castform_script(ad, b, form);
        return true;
      }
    }
  }
  return false;
};

// Lua: abilities.lua:117
function weather_form_changes(ad: any): void {
  for (let i = 1; i <= 2; i++) {
    if (!Abilities.forecast(ad)) break;
  }
}

// Lua: abilities.lua:124 -- pokefirered/src/battle_util.c:1698
Abilities.ghostBlocks = function (st: any, ab: any): boolean {
  // st and st.ghostBattle and not st.ghostUnveiled and (ab == "INTIMIDATE" or ab == "TRACE") or false
  return (truthy(st) && truthy(st.ghostBattle) && !truthy(st.ghostUnveiled) && (ab === "INTIMIDATE" || ab === "TRACE")) || false;
};

// Lua: abilities.lua:129 -- pokefirered/src/battle_util.c:1704
Abilities.switchIn = function (ad: any, b: any): boolean {
  if (!truthy(b) || truthy(ad.isFainted(b))) return false;
  const st = ad._st;
  const ab = ad.abilityOf(b);
  if (Abilities.ghostBlocks(st, ab)) return false;
  if (ab === "DRIZZLE") {
    if (!weather_permanent(st, "RAIN")) {
      st.weather = "RAIN"; st.weatherTurns = 0;
      say_id(ad, "STRINGID_PKMNMADEITRAIN", { scrActive: b, scrActiveAbility: Abilities.id(ab) });
      ad.playAnim("general", "RAIN_CONTINUES", null, null);
      weather_form_changes(ad);
      return true;
    }
  } else if (ab === "SAND_STREAM") {
    if (!weather_permanent(st, "SAND")) {
      st.weather = "SAND"; st.weatherTurns = 0;
      say_id(ad, "STRINGID_PKMNSXWHIPPEDUPSANDSTORM", { scrActive: b, scrActiveAbility: Abilities.id(ab) });
      ad.playAnim("general", "SANDSTORM_CONTINUES", null, null);
      weather_form_changes(ad);
      return true;
    }
  } else if (ab === "DROUGHT") {
    if (!weather_permanent(st, "SUN")) {
      st.weather = "SUN"; st.weatherTurns = 0;
      say_id(ad, "STRINGID_PKMNSXINTENSIFIEDSUN", { scrActive: b, scrActiveAbility: Abilities.id(ab) });
      ad.playAnim("general", "SUN_CONTINUES", null, null);
      weather_form_changes(ad);
      return true;
    }
  } else if (ab === "INTIMIDATE") {
    if (!truthy(b.expIntimidated)) {
      b.expIntimidatePending = true;
      b.expIntimidated = true;
    }
  } else if (ab === "FORECAST") {
    const form = Abilities.castformChange(ad, b);
    if (form !== 0) {
      castform_script(ad, b, form);
      return true;
    }
  } else if (ab === "TRACE") {
    if (!truthy(b.expTraced)) {
      b.expTracePending = true;
      b.expTraced = true;
    }
  } else if (ab === "CLOUD_NINE" || ab === "AIR_LOCK") {
    for (const [, o] of ipairs(ad.activeBattlers())) {
      const form = Abilities.castformChange(ad, o);
      if (form !== 0) {
        castform_script(ad, o, form);
        return true;
      }
    }
  }
  return false;
};

// Lua: abilities.lua:187 -- pokefirered/data/battle_scripts_1.s:3983
function intimidate_one(ad: any, b: any, foe: any): void {
  if (!(truthy(foe) && !truthy(ad.isFainted(foe)) && (foe.substituteHP ?? 0) <= 0)) return;
  const fab = ad.abilityOf(foe);
  if (fab === "CLEAR_BODY" || fab === "HYPER_CUTTER" || fab === "WHITE_SMOKE") {
    // src/battle_script_commands.c:9181
    say_id(ad, "STRINGID_PREVENTEDFROMWORKING", {
      def: foe, defAbility: Abilities.id(fab), scrActive: b, buff1: Abilities.name(ad.abilityOf(b)),
    });
  } else {
    const side = ad.ownSide(foe);
    if (truthy(side) && (side.expMistTurns ?? 0) > 0) {
      if (!truthy(foe._statLoweredMsg)) {
        foe._statLoweredMsg = true;
        say_id(ad, "STRINGID_PKMNPROTECTEDBYMIST", { scrActive: foe });
      }
    } else if ((foe.stages.attack ?? 0) > -6) {
      foe.stages.attack = foe.stages.attack - 1;
      ad.playAnim("general", "STATS_CHANGE", foe, foe, Secondary.statAnimArg("attack", -1));
      say_id(ad, "STRINGID_PKMNCUTSATTACKWITH", { scrActive: b, scrActiveAbility: ab_id(ad, b), def: foe });
    }
  }
}

// Lua: abilities.lua:210
Abilities.runIntimidate = function (ad: any): boolean {
  for (const [, b] of ipairs(ad.activeBattlers())) {
    if (truthy(b.expIntimidatePending) && ad.abilityOf(b) === "INTIMIDATE") {
      b.expIntimidatePending = null;
      if (truthy(ad._st) && truthy(ad._st.double)) {
        // pokefirered/src/battle_script_commands.c:9174
        for (const [, foe] of ipairs(ad.foesOf(b))) intimidate_one(ad, b, foe);
      } else {
        intimidate_one(ad, b, ad.foeOf(b));
      }
      return true;
    }
  }
  return false;
};

// Lua: abilities.lua:227 -- pokefirered/src/battle_util.c:2231
Abilities.runTrace = function (ad: any): boolean {
  for (const [, b] of ipairs(ad.activeBattlers())) {
    if (truthy(b.expTracePending) && ad.abilityOf(b) === "TRACE") {
      let foe = ad.foeOf(b);
      const st = ad._st;
      if (truthy(st) && truthy(st.double)) {
        // pokefirered/src/battle_util.c:2243
        const side = (mod(b.id, 2) === 0) ? 1 : 0;
        const t1 = State.battler(st, side), t2 = State.battler(st, side + 2);
        const ok1 = truthy(t1) && truthy(ad.abilityOf(t1)) && ad.hp(t1) > 0;
        const ok2 = truthy(t2) && truthy(ad.abilityOf(t2)) && ad.hp(t2) > 0;
        if (ok1 && ok2) {
          foe = State.battler(st, ad.roll(0, 1) * 2 + side);
        } else if (ok1) {
          foe = t1;
        } else if (ok2) {
          foe = t2;
        } else {
          foe = null;
        }
      }
      const fab = truthy(foe) ? ad.abilityOf(foe) : foe;
      if (truthy(fab) && ad.hp(foe) > 0) {
        b.expTracePending = null;
        b.expTracedAbility = fab;
        // src/battle_util.c:2281
        say_id(ad, "STRINGID_PKMNTRACED", {
          scrActive: b, buff1: State.prefixedName(st, foe), buff2: Abilities.name(fab),
        });
        return true;
      }
    }
  }
  return false;
};

// Lua: abilities.lua:265 -- pokefirered/src/battle_util.c:1816
Abilities.endTurn = function (ad: any, b: any): boolean {
  if (!truthy(b) || ad.hp(b) <= 0) return false;
  const ab = ad.abilityOf(b);
  if (ab === "RAIN_DISH") {
    if (weather_active(ad) === "RAIN" && ad.maxHp(b) > ad.hp(b)) {
      let amt = Math.floor(ad.maxHp(b) / 16);
      if (amt === 0) amt = 1;
      say_id(ad, "STRINGID_PKMNSXRESTOREDHPALITTLE2", { atk: b, atkAbility: Abilities.id(ab) });
      ad.heal(b, amt);
      return true;
    }
  } else if (ab === "SHED_SKIN") {
    const s = ad.status(b);
    if (truthy(s) && mod(ad.roll(0, 2), 3) === 0) {
      const word = STATUS_WORD[s];
      ad.clearStatus(b);
      b.expNightmare = null;
      say_id(ad, "STRINGID_PKMNSXCUREDYPROBLEM", {
        scrActive: b, scrActiveAbility: Abilities.id(ab), buff1: RomText.plain(word as string),
      });
      return true;
    }
  } else if (ab === "SPEED_BOOST") {
    if ((b.stages.speed ?? 0) < 6 && (b.isFirstTurn ?? 0) !== 2) {
      b.stages.speed = (b.stages.speed ?? 0) + 1;
      ad.playAnim("general", "STATS_CHANGE", b, b, Secondary.statAnimArg("speed", 1));
      say_id(ad, "STRINGID_PKMNRAISEDSPEED", { scrActive: b, scrActiveAbility: Abilities.id(ab) });
      return true;
    }
  } else if (ab === "TRUANT") {
    b.expTruantCounter = ((b.expTruantCounter ?? 0) === 0) ? 1 : 0;
  }
  return false;
};

// Lua: abilities.lua:301 -- pokefirered/src/battle_util.c:1337
Abilities.truantLoafs = function (ad: any, b: any): boolean {
  return ad.abilityOf(b) === "TRUANT" && (b.expTruantCounter ?? 0) !== 0;
};

// Lua: abilities.lua:306 -- pokefirered/src/battle_util.c:1874
Abilities.soundproofBlocks = function (M: any): boolean {
  const ad = M.adapter, target = M.target;
  if (!truthy(target) || target === M.user) return false;
  if (ad.abilityOf(target) !== "SOUNDPROOF" || !truthy(SOUND_MOVES[M.mnum ?? -1])) return false;
  if (truthy(M.user.expLockedMove)) M.noPP = true;
  M.attackString();
  M.ppReduce();
  say_id(ad, "STRINGID_PKMNSXBLOCKSY", { def: target, defAbility: ab_id(ad, target), currentMove: M.moveName });
  M.anim.statusOnly = true;
  M.anim.missed = true;
  M.noEffect = true;
  return true;
};

// Lua: abilities.lua:321 -- pokefirered/src/battle_util.c:1891
Abilities.absorb = function (M: any): boolean {
  const ad = M.adapter, user = M.user, target = M.target;
  if (truthy(M.absorbChecked) || !truthy(target) || target === user) return false;
  M.absorbChecked = true;
  const ab = ad.abilityOf(target);
  const mt = tonumber(truthy(M.moveType) ? M.moveType : (truthy(M.move) ? M.move.type : M.move)) ?? 0;
  const power = tonumber(truthy(M.move) ? M.move.power : M.move) ?? 0;
  let kind: string | null = null;
  if (ab === "VOLT_ABSORB" && mt === Types.ID.ELECTRIC && power !== 0) kind = "hp";
  else if (ab === "WATER_ABSORB" && mt === Types.ID.WATER && power !== 0) kind = "hp";
  else if (ab === "FLASH_FIRE" && mt === Types.ID.FIRE && ad.status(target) !== "FRZ") kind = "fire";
  if (!truthy(kind)) return false;
  M.attackString();
  M.absorbed = true;
  M.noEffect = true;
  M.anim.missed = true;
  if (kind === "fire") {
    if (!truthy(target.expFlashFire)) {
      target.expFlashFire = true;
      say_id(ad, "STRINGID_PKMNRAISEDFIREPOWERWITH", { def: target, defAbility: Abilities.id(ab) });
    } else {
      say_id(ad, "STRINGID_PKMNSXMADEYINEFFECTIVE", {
        def: target, defAbility: Abilities.id(ab), currentMove: M.moveName,
      });
    }
    return true;
  }
  if (ad.hp(target) >= ad.maxHp(target)) {
    say_id(ad, "STRINGID_PKMNSXMADEYUSELESS", { def: target, defAbility: Abilities.id(ab), currentMove: M.moveName });
  } else {
    let amt = Math.floor(ad.maxHp(target) / 4);
    if (amt === 0) amt = 1;
    ad.heal(target, amt);
    say_id(ad, "STRINGID_PKMNRESTOREDHPUSING", { def: target, defAbility: Abilities.id(ab) });
  }
  return true;
};

// src/battle_message.c:1076
const STATUS_BY_ABILITY: Record<string, string> = {
  PAR: "STRINGID_PKMNWASPARALYZEDBY",
  PSN: "STRINGID_PKMNPOISONEDBY",
  BRN: "STRINGID_PKMNBURNEDBY",
  SLP: "STRINGID_PKMNMADESLEEP",
};

// Lua: abilities.lua:368 -- pokefirered/src/battle_script_commands.c:2110
Abilities.applyStatus = function (ad: any, holder: any, victim: any, status: any, primary: any, M?: any): boolean {
  if (!truthy(victim) || ad.hp(victim) <= 0) return false;
  if ((victim.substituteHP ?? 0) > 0 && victim !== (truthy(M) ? M.user : M)) return false;
  const vab = ad.abilityOf(victim);
  // Lua: abilities.lua:372
  function prevents(): boolean {
    if (truthy(M)) {
      say_id(ad, "STRINGID_PKMNSXPREVENTSYSZ", {
        atk: M.user, atkAbility: ab_id(ad, M.user), def: M.target, defAbility: ab_id(ad, M.target),
      });
    }
    return false;
  }
  // Lua: abilities.lua:380
  function no_effect(): boolean {
    say_id(ad, "STRINGID_PKMNSXHADNOEFFECTONY", { scrActive: holder, scrActiveAbility: ab_id(ad, holder), eff: victim });
    return false;
  }
  if (status === "SLP") {
    if (truthy(ad.status(victim))) return false;
    if (vab !== "SOUNDPROOF" && truthy(ad.uproarActive())) return false;
    if (vab === "VITAL_SPIRIT" || vab === "INSOMNIA") return false;
  } else if (status === "PSN" || status === "TOX") {
    if (vab === "IMMUNITY" && truthy(primary)) return prevents();
    if ((is_type(victim, Types.ID.POISON) || is_type(victim, Types.ID.STEEL)) && truthy(primary)) return no_effect();
    if (is_type(victim, Types.ID.POISON) || is_type(victim, Types.ID.STEEL)) return false;
    if (truthy(ad.status(victim)) || vab === "IMMUNITY") return false;
  } else if (status === "BRN") {
    if (vab === "WATER_VEIL" && truthy(primary)) return prevents();
    if (is_type(victim, Types.ID.FIRE) && truthy(primary)) return no_effect();
    if (is_type(victim, Types.ID.FIRE) || vab === "WATER_VEIL" || truthy(ad.status(victim))) return false;
  } else if (status === "PAR") {
    if (vab === "LIMBER") {
      if (truthy(primary)) return prevents();
      return false;
    }
    if (truthy(ad.status(victim))) return false;
  } else {
    return false;
  }
  ad.applyStatus(victim, status, holder, { force: true, ignoreSafeguard: true });
  ad.statusAnim(victim, status);
  if (status !== "SLP") ad._syncEffect = { status: status };
  if (status === "TOX") {
    say_id(ad, "STRINGID_PKMNBADLYPOISONED", { eff: victim });
  } else {
    say_id(ad, STATUS_BY_ABILITY[status]!, { scrActive: holder, scrActiveAbility: ab_id(ad, holder), eff: victim });
  }
  return true;
};

// Lua: abilities.lua:417
function contact(M: any): boolean {
  const f = truthy(M.move) ? M.move.flags : M.move;
  return f != null && mod(tonumber(f) ?? 0, 2) === 1;
}

// Lua: abilities.lua:423 -- pokefirered/src/battle_util.c:1964
Abilities.onDamage = function (M: any): boolean {
  const ad = M.adapter, user = M.user, target = M.target;
  if (!truthy(target) || target === user || truthy(M.noEffect) || !truthy(M.targetDamaged)) return false;
  const ab = ad.abilityOf(target);
  const mt = tonumber(truthy(M.moveType) ? M.moveType : (truthy(M.move) ? M.move.type : M.move)) ?? 0;
  if (ab === "COLOR_CHANGE") {
    if (M.mnum !== 165 && (tonumber(M.move.power) ?? 0) !== 0 && !is_type(target, mt) && ad.hp(target) > 0) {
      set_type(target, mt);
      say_id(ad, "STRINGID_PKMNCHANGEDTYPEWITH", { def: target, defAbility: Abilities.id(ab), buff1: Types.name(mt) });
      return true;
    }
    return false;
  }
  if (ad.hp(user) <= 0 || !contact(M)) return false;
  if (ab === "ROUGH_SKIN") {
    let amt = Math.floor(ad.maxHp(user) / 16);
    if (amt === 0) amt = 1;
    ad.applyHpLoss(user, amt);
    say_id(ad, "STRINGID_PKMNHURTSWITH", { def: target, defAbility: Abilities.id(ab), atk: user });
    M.tryFaintUser();
    return true;
  } else if (ab === "EFFECT_SPORE") {
    if (mod(ad.roll(0, 9), 10) === 0) {
      let r: number;
      do { r = mod(ad.roll(0, 3), 4); } while (!(r !== 0));
      const status = seq("SLP", "PSN", "PAR")[r];
      Abilities.applyStatus(ad, target, user, status, false, M);
      return true;
    }
  } else if (ab === "POISON_POINT" || ab === "STATIC" || ab === "FLAME_BODY") {
    if (mod(ad.roll(0, 2), 3) === 0) {
      const status = (ab === "POISON_POINT" && "PSN") || (ab === "STATIC" && "PAR") || "BRN";
      Abilities.applyStatus(ad, target, user, status, false, M);
      return true;
    }
  } else if (ab === "CUTE_CHARM") {
    if (ad.hp(target) > 0 && mod(ad.roll(0, 2), 3) === 0 && ad.abilityOf(user) !== "OBLIVIOUS") {
      const ug = gender_of(user), tg = gender_of(target);
      if (ug !== tg && !truthy(user.expInfatuated) && ug !== "U" && tg !== "U") {
        user.expInfatuated = true;
        user.expInfatuatedBy = target.side;
        user.expInfatuatedWith = target;
        ad.playAnim("status", "INFATUATION", user, user);
        say_id(ad, "STRINGID_PKMNSXINFATUATEDY", { def: target, defAbility: Abilities.id(ab), atk: user });
        return true;
      }
    }
  }
  return false;
};

// Lua: abilities.lua:475 -- pokefirered/src/battle_util.c:2087
Abilities.immunityCure = function (ad: any): boolean {
  let any = false;
  for (const [, b] of ipairs(ad.activeBattlers())) {
    const ab = ad.abilityOf(b);
    const s = ad.status(b);
    let word: string | null = null, kind: number | null = null;
    if (ab === "IMMUNITY" && (s === "PSN" || s === "TOX")) { word = "gText_Poison"; kind = 1; }
    else if (ab === "OWN_TEMPO" && (b.confusionTurns ?? 0) > 0) { word = "gText_Confusion"; kind = 2; }
    else if (ab === "LIMBER" && s === "PAR") { word = "gText_Paralysis"; kind = 1; }
    else if ((ab === "INSOMNIA" || ab === "VITAL_SPIRIT") && s === "SLP") {
      b.expNightmare = null;
      word = "gText_Sleep"; kind = 1;
    } else if (ab === "WATER_VEIL" && s === "BRN") { word = "gText_Burn"; kind = 1; }
    else if (ab === "MAGMA_ARMOR" && s === "FRZ") { word = "gText_Ice"; kind = 1; }
    else if (ab === "OBLIVIOUS" && truthy(b.expInfatuated)) { word = "gText_Love"; kind = 3; }
    if (truthy(kind)) {
      if (kind === 1) ad.clearStatus(b);
      else if (kind === 2) b.confusionTurns = null;
      else { b.expInfatuated = null; b.expInfatuatedWith = null; b.expInfatuatedBy = null; }
      say_id(ad, "STRINGID_PKMNSXCUREDYPROBLEM", {
        scrActive: b, scrActiveAbility: Abilities.id(ab), buff1: RomText.plain(word as string),
      });
      any = true;
    }
  }
  return any;
};

// Lua: abilities.lua:504 -- pokefirered/src/battle_util.c:2185
Abilities.synchronize = function (M: any, holder: any, victim: any): boolean {
  const ad = M.adapter;
  const pend = ad._syncEffect;
  if (!truthy(pend) || !truthy(holder) || ad.abilityOf(holder) !== "SYNCHRONIZE") return false;
  ad._syncEffect = null;
  let status = pend.status;
  if (status === "TOX") status = "PSN";
  Abilities.applyStatus(ad, holder, victim, status, true, M);
  return true;
};

// Lua: abilities.lua:516 -- pokefirered/src/battle_main.c:3002
Abilities.escapeBlocker = function (ad: any, b: any): [any, string?] {
  if (truthy(ad._st) && truthy(ad._st.double)) {
    for (const [, foe] of ipairs(ad.foesOf(b))) {
      if (!truthy(ad.isFainted(foe))) {
        const fab = ad.abilityOf(foe);
        if (fab === "SHADOW_TAG") return [foe, fab];
        if (fab === "ARENA_TRAP" && ad.abilityOf(b) !== "LEVITATE" && !is_type(b, Types.ID.FLYING)) {
          return [foe, fab];
        }
      }
    }
    // pokefirered/src/battle_main.c:3036
    if (is_type(b, Types.ID.STEEL)) {
      for (const [, o] of ipairs(ad.activeBattlers())) {
        if (o !== b && !truthy(ad.isFainted(o)) && ad.abilityOf(o) === "MAGNET_PULL") return [o, "MAGNET_PULL"];
      }
    }
    return [null];
  }
  const foe = ad.foeOf(b);
  if (!truthy(foe) || truthy(ad.isFainted(foe))) return [null];
  const fab = ad.abilityOf(foe);
  if (fab === "SHADOW_TAG") return [foe, fab];
  if (fab === "ARENA_TRAP" && ad.abilityOf(b) !== "LEVITATE" && !is_type(b, Types.ID.FLYING)) {
    return [foe, fab];
  }
  if (fab === "MAGNET_PULL" && is_type(b, Types.ID.STEEL)) return [foe, fab];
  return [null];
};

// Lua: abilities.lua:547 -- pokefirered/src/battle_script_commands.c:9197
Abilities.switchOut = function (ad: any, b: any): boolean {
  if (truthy(b) && ad.abilityOf(b) === "NATURAL_CURE" && truthy(ad.status(b))) {
    ad.clearStatus(b);
    const pm = State.partyMon(b);
    if (truthy(pm)) pm.status = null;
    return true;
  }
  return false;
};

export default Abilities;
