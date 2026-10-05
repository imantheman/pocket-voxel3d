// Port of gen1recomp src/core/game3/battle/anim_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// The battle presentation sequencer: turns the engine's event stream (msg,
// move, anim, hit, hp, faint, switch, end) into steps and plays them through
// Anim (move animations, HP tweens, blinks, faints, switches) in pret order.

import { mod, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, seq, type LuaTable } from "../../platform/lt.ts";
import { Runtime } from "../runtime.ts";
import { Options } from "../options.ts";
import { SE } from "../se_ids.ts";
import { Audio } from "../audio.ts";
import { Anim } from "./anim.ts";
import { AnimCtx } from "./anim_ctx.ts";
import { AnimCoords } from "./anim_coords.ts";
import { State } from "./state.ts";
import { Moves } from "./moves.ts";
import { SwitchSeq } from "./switch_seq.ts";
import { Ui } from "./ui.ts";
import { Battle } from "./init.ts";

const MOVE_TRANSFORM = 144;
const MOVE_SUBSTITUTE = 164;
const PAUSE_SHORT = 32;
const EFFECT_SEMI_INVULNERABLE = 155;

// pokefirered/src/battle_script_commands.c:3856
const ALWAYS_GENERAL: Record<string, boolean> = { STATS_CHANGE: true, SNATCH_MOVE: true, SUBSTITUTE_FADE: true, SILPH_SCOPED: true };
const WEATHER_GENERAL: Record<string, boolean> = { RAIN_CONTINUES: true, SUN_CONTINUES: true, SANDSTORM_CONTINUES: true, HAIL_CONTINUES: true };
// pokefirered/src/battle_gfx_sfx_util.c:250
const SUB_EXEMPT_GENERAL: Record<string, boolean> = {
  SUBSTITUTE_FADE: true, RAIN_CONTINUES: true, SUN_CONTINUES: true,
  SANDSTORM_CONTINUES: true, HAIL_CONTINUES: true, SNATCH_MOVE: true,
};
// pokefirered/data/battle_scripts_1.s:3913
const TARGET_ACTIVE_GENERAL: Record<string, boolean> = { ITEM_STEAL: true, ITEM_KNOCKOFF: true, SNATCH_MOVE: true };

// Lua: anim_seq.lua:36
function to_id(v: unknown): number | null {
  if (typeof v === "number") return v;
  return AnimCoords.fixedId(v);
}

// Lua: anim_seq.lua:41
function side_of(id: unknown): string {
  return AnimCoords.sideOf(id);
}

// Lua: anim_seq.lua:45
function opposite(id: number | null | undefined): number {
  return (id ?? 0) ^ 1;
}

// Lua: anim_seq.lua:49
function ev_id(ev: any, idKey: string, sideKey: string): number | null {
  const v = ev[idKey];
  if (typeof v === "number") return v;
  return to_id(ev[sideKey]);
}

// Lua: anim_seq.lua:55
function battle_state(): any {
  // package.loaded["src.core.game3.battle"]
  const B: any = Battle;
  return B != null ? B._st : undefined;
}

// Lua: anim_seq.lua:60
function battler_of(id: unknown): any {
  return AnimCoords.battler(battle_state(), to_id(id));
}

// Lua: anim_seq.lua:64
function species_of(idIn: unknown): any {
  const id = to_id(idIn);
  const b = Anim.shownBattler(id, battler_of(id));
  if (b == null || typeof b !== "object") return null;
  const p = id != null ? Anim._present[id] : null;
  if (b.expTransform && p && !p.pendingTransform) {
    return p.transformSpecies ?? b.expTransform.species;
  }
  return b.species ?? (b.mon ? (b.mon.species ?? b.mon.speciesId) : null);
}

// Lua: anim_seq.lua:75
function scene_on(): boolean {
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : null;
  if (session && Options.battleScene) {
    return Options.battleScene(session) !== false;
  }
  return true;
}

// Lua: anim_seq.lua:85
function effectiveness_se(effIn: unknown): number | null {
  const eff = tonumber(effIn) ?? 1;
  if (eff === 0) return null;
  if (eff >= 2) return SE.SE_SUPER_EFFECTIVE;
  if (eff > 0 && eff < 1) return SE.SE_NOT_EFFECTIVE;
  return SE.SE_EFFECTIVE;
}

// Lua: anim_seq.lua:95 -- pokefirered/src/battle_script_commands.c:1883
function play_effectiveness_se(eff: unknown, battler: unknown): void {
  const id = effectiveness_se(eff);
  if (id == null) return;
  const pan = (side_of(to_id(battler) ?? 1) === "player") ? -64 : 63;
  try {
    Audio.playSe(id, { pan });
  } catch { /* pcall */ }
}

// Lua: anim_seq.lua:104
function flush_pending_eff(): void {
  const p = AnimSeq._pendingEff;
  AnimSeq._pendingEff = null;
  if (p && p.effectiveness != null) {
    play_effectiveness_se(p.effectiveness, p.battler ?? p.side);
  }
}

// Lua: anim_seq.lua:112
function stand_in(id: number, slot: unknown): any {
  const st = battle_state();
  const side = side_of(id);
  const party = st ? ((side === "player") ? st.playerParty : st.foeParty) : null;
  const mon = party && slot != null ? party[slot as number] : null;
  if (!mon) return null;
  try {
    return State.makeBattler(mon, side, { partyIndex: slot, id, st }) ?? null;
  } catch {
    return null;
  }
}

// Lua: anim_seq.lua:145
function reconcile_sprites(): void {
  const st = battle_state();
  if (!st || Anim._headless) return;
  for (const [, id] of ipairs<number>(AnimCoords.ids(st))) {
    const p = Anim._present[id];
    if (p) {
      p.shown = null;
      p.blinkHidden = false;
      p.pendingTransform = null;
      p.invisible = null;
      p.battlerInvisible = null;
    }
    const b = AnimCoords.battler(st, id);
    const alive = b && b.mon && (tonumber(b.mon.hp) ?? 0) > 0 && !(st.absent && st.absent[id]);
    if (p && alive && !st.over) {
      if (b.semiInvulnerable && AnimSeq._scene) {
        p.visible = false;
      } else if (p.visible === false && !b.semiInvulnerable && !p.switchedOut) {
        p.visible = true;
        p.alpha = 1;
      }
      const subbed = (b.substituteHP ?? 0) > 0;
      if (subbed !== (p.substitute === true) && !AnimSeq._subLowered[id]) {
        Anim.setSubstitute(id, subbed);
      }
    }
  }
}

// Lua: anim_seq.lua:174
function finish_seq(): void {
  if (AnimSeq._steps) reconcile_sprites();
  AnimSeq._steps = null;
  AnimSeq._i = 1;
  AnimSeq._waiting = false;
  AnimSeq._waitingMsg = false;
  AnimSeq._waitFrames = 0;
  AnimSeq._waitSwitch = false;
  Anim.setSeqBusy(false);
}

// Lua: anim_seq.lua:185
function advance(): void {
  AnimSeq._waiting = false;
  AnimSeq._i = AnimSeq._i + 1;
}

// Lua: anim_seq.lua:190
function ids(list: string[]): Record<string, boolean> {
  const set: Record<string, boolean> = {};
  for (const k of list) set[k] = true;
  return set;
}

// data/battle_scripts_1.s:279
const MISS_IDS = ids([
  "STRINGID_ATTACKMISSED", "sText_AttackMissed",
  "STRINGID_PKMNPROTECTEDITSELF", "STRINGID_PKMNPROTECTEDITSELF2", "sText_PkmnProtectedItself",
  "STRINGID_ITDOESNTAFFECT", "sText_ItDoesntAffect",
  "STRINGID_PKMNAVOIDEDATTACK", "sText_PkmnAvoidedAttack",
  "STRINGID_PKMNUNAFFECTED", "sText_PkmnUnaffected",
  "STRINGID_PKMNPROTECTEDBY", "sText_PkmnProtectedBy",
]);
const CONFUSION_IDS = ids(["STRINGID_ITHURTCONFUSION", "sText_ItHurtConfusion"]);
const SUBSTITUTE_IDS = ids(["STRINGID_SUBSTITUTEDAMAGED", "sText_SubstituteDamaged"]);
// src/battle_message.c:1693
const USED_IDS = ids([
  "STRINGID_USEDMOVE", "sText_AttackerUsedX",
  "STRINGID_PLAYERUSEDITEM", "sText_PlayerUsedItem",
  "STRINGID_OLDMANUSEDITEM", "sText_OldManUsedItem",
  "sText_PokedudeUsedItem",
  "STRINGID_PKMNUSEDXTOGETPUMPED", "sText_PkmnUsedXToGetPumped",
  "Text_MonUsedMove",
]);

// Lua: anim_seq.lua:221
function is_miss(ev: any): boolean {
  return ev.id != null && MISS_IDS[ev.id] === true;
}

// Lua: anim_seq.lua:327
function start(steps: LuaTable, pushMsg: any): void {
  if (len(steps) === 0) {
    finish_seq();
    return;
  }
  const held: Record<number, boolean> = {};
  for (const [, step] of ipairs<any>(steps)) {
    const d = step.data ?? {};
    if (step.kind === "move" && tonumber(d.moveId) === MOVE_TRANSFORM) {
      const p = Anim.present(ev_id(d, "attackerId", "attacker") ?? 0);
      if (p) p.pendingTransform = true;
    } else if (step.kind === "switch_out" && d.slot != null) {
      const b = ev_id(d, "battler", "side");
      if (b != null && !held[b]) {
        held[b] = true;
        Anim.setShown(b, stand_in(b, d.slot));
      }
    }
  }
  AnimSeq._steps = steps;
  AnimSeq._i = 1;
  AnimSeq._waiting = false;
  AnimSeq._pushMsg = pushMsg;
  Anim.setSeqBusy(true);
}

// Lua: anim_seq.lua:366
function wait_anim(): void {
  AnimSeq._waiting = true;
}

// Lua: anim_seq.lua:370
function launch_done(): void {
  if (AnimSeq._waiting && !Anim.busy()) {
    advance();
  }
}

// Lua: anim_seq.lua:376
function pause(frames: unknown): void {
  AnimSeq._waitFrames = frames ?? PAUSE_SHORT;
}

// Lua: anim_seq.lua:380
function ctx_for(attacker: unknown, target: unknown, opts?: Record<string, any>): Record<string, any> {
  opts = opts || {};
  opts.lowered = AnimSeq._subLowered;
  return AnimCtx.build(attacker, target, opts);
}

// Lua: anim_seq.lua:386
function species_by_id(a: number, t: number): Record<number, any> | null {
  if (!AnimCoords.isDouble(battle_state())) return null;
  const out: Record<number, any> = {};
  for (let id = 0; id <= 3; id++) {
    if (id !== a && id !== t) out[id] = species_of(id);
  }
  return out;
}

// Lua: anim_seq.lua:395
function launch_opts(a: number, t: number, extra?: Record<string, any>): Record<string, any> {
  const o: Record<string, any> = {
    attackerSide: side_of(a),
    targetSide: side_of(t),
    attackerId: a,
    targetId: t,
    isReversed: side_of(a) === "enemy",
    attackerSpecies: species_of(a),
    targetSpecies: species_of(t),
    speciesById: species_by_id(a, t),
  };
  for (const [k, v] of pairs(extra ?? {})) o[k] = v;
  return o;
}

// Lua: anim_seq.lua:410 -- returns [attacker, target]
function move_ids(d: any): [number, number] {
  const a = ev_id(d, "attackerId", "attacker") ?? 0;
  let t = ev_id(d, "targetId", "target");
  if (t == null) t = opposite(a);
  return [a, t];
}

// Lua: anim_seq.lua:417 -- returns [ctx, mv]
function move_ctx(d: any): [Record<string, any>, any] {
  const [attacker, target] = move_ids(d);
  const ctx = ctx_for(attacker, target, { moveId: d.moveId, moveDmg: d.damage });
  if (tonumber(d.power) != null) ctx.movePower = tonumber(d.power);
  const M: any = Moves;
  const mv = M.get ? M.get(d.moveId) : null;
  return [ctx, mv];
}

// Lua: anim_seq.lua:426
function after_move(d: any, mv: any): void {
  const id = move_ids(d)[0];
  const p = Anim.present(id);
  if (!p) return;
  if (tonumber(d.moveId) === MOVE_TRANSFORM) p.pendingTransform = null;
  if (!AnimSeq._scene) return;
  if (tonumber(d.moveId) === MOVE_SUBSTITUTE) {
    const b = battler_of(id);
    if (b && (b.substituteHP ?? 0) > 0 && !p.substitute) {
      Anim.setSubstitute(id, true);
      p.visible = true;
      p.ox = 0; p.oy = 0;
    }
  }
  if (mv && tonumber(mv.effect) === EFFECT_SEMI_INVULNERABLE) {
    // pokefirered/src/battle_controller_player.c:2370
    if ((tonumber(d.turn) ?? 0) === 0) {
      p.visible = false;
    } else {
      p.visible = true;
    }
  }
}

// Lua: anim_seq.lua:450
function run_move(d: any): void {
  if (!AnimSeq._scene && tonumber(d.moveId) !== MOVE_TRANSFORM && tonumber(d.moveId) !== MOVE_SUBSTITUTE) {
    // pokefirered/src/battle_script_commands.c:1667
    pause(PAUSE_SHORT);
    advance();
    return;
  }
  const [ctx, mv] = move_ctx(d);
  wait_anim();
  const [attacker, target] = move_ids(d);
  Anim.launchMove(d.moveId, launch_opts(attacker, target, {
    moveTurn: d.turn ?? 0,
    ctx,
    onEnd: () => {
      after_move(d, mv);
      if (AnimSeq._waiting) advance();
    },
  }));
  launch_done();
}

// Lua: anim_seq.lua:471
function general_arg(d: any): number {
  if (d.name === "LEECH_SEED_DRAIN") {
    // pokefirered/src/battle_util.c:798
    const [a, seeder] = move_ids(d);
    return seeder + a * 256;
  }
  return tonumber(d.arg) ?? 0;
}

// Lua: anim_seq.lua:480
function run_general(d: any): void {
  const name = d.name;
  const a = move_ids(d)[0];
  const tgtActive = TARGET_ACTIVE_GENERAL[name] ? ev_id(d, "targetId", "target") : null;
  const active = tgtActive ?? a;
  const p = Anim.present(active);
  const castform = name === "CASTFORM_CHANGE";
  if (castform) {
    const b = battler_of(active);
    const arg = tonumber(d.arg) ?? 0;
    if (p) p.castformMon = b && b.mon;
    // pokefirered/src/battle_gfx_sfx_util.c:212
    if (arg >= 128) {
      if (p) p.castformForm = mod(arg, 128);
      advance();
      return;
    }
  }
  if (!ALWAYS_GENERAL[name] && !castform) {
    if (!AnimSeq._scene) {
      // pokefirered/src/battle_script_commands.c:3865
      pause(PAUSE_SHORT);
      advance();
      return;
    }
    const ab = battler_of(active);
    if (!WEATHER_GENERAL[name] && ab && ab.semiInvulnerable) {
      advance();
      return;
    }
  }
  if (p && p.substitute && !SUB_EXEMPT_GENERAL[name] && !castform) {
    advance();
    return;
  }
  if (name === "SUBSTITUTE_FADE" && p && p.substitute && p.visible === false) {
    Anim.setSubstitute(active, false);
    advance();
    return;
  }
  wait_anim();
  Anim.launchGeneral(name, launch_opts(active, active, {
    animArg: general_arg(d),
    ctx: ctx_for(active, active, { animArg: general_arg(d) }),
    onEnd: () => {
      if (castform && p) {
        p.castformForm = mod(tonumber(d.arg) ?? 0, 128);
      } else if (name === "SILPH_SCOPED" && p) {
        p.ghostUnveiled = true;
      }
      if (name === "SUBSTITUTE_FADE") {
        Anim.setSubstitute(active, false);
        const pp = Anim.present(active);
        if (pp) {
          pp.alpha = 1;
          pp.visible = true;
        }
      }
      if (AnimSeq._waiting) advance();
    },
  }));
  launch_done();
}

// Lua: anim_seq.lua:544 -- pokefirered/src/battle_script_commands.c:5494
function run_status(d: any): void {
  let id = ev_id(d, "attackerId", "attacker");
  if (id == null) id = ev_id(d, "targetId", "target") ?? 0;
  const b = battler_of(id);
  if (!AnimSeq._scene || (b && (b.semiInvulnerable || (b.substituteHP ?? 0) > 0))) {
    advance();
    return;
  }
  wait_anim();
  Anim.launchStatus(d.name, launch_opts(id, id, {
    force: true,
    ctx: ctx_for(id, id),
    onEnd: () => {
      if (AnimSeq._waiting) advance();
    },
  }));
  launch_done();
}

// Lua: anim_seq.lua:563
function run_special(d: any): void {
  const id = ev_id(d, "attackerId", "attacker") ?? 0;
  const p = Anim.present(id);
  if (d.name === "SUBSTITUTE_TO_MON" || d.name === "MON_TO_SUBSTITUTE") {
    const mid = tonumber(d.moveId);
    if (!AnimSeq._scene && mid !== MOVE_TRANSFORM && mid !== MOVE_SUBSTITUTE) {
      advance();
      return;
    }
    // pokefirered/src/battle_controller_player.c:2338
    if (d.name === "SUBSTITUTE_TO_MON") {
      if (!(p && p.substitute)) { advance(); return; }
      AnimSeq._subLowered[id] = true;
    } else {
      if (!AnimSeq._subLowered[id]) { advance(); return; }
      delete AnimSeq._subLowered[id];
      const b = battler_of(id);
      if (b && (b.substituteHP ?? 0) <= 0) { advance(); return; }
    }
  }
  wait_anim();
  Anim.launchSpecial(d.name, launch_opts(id, id, {
    ctx: ctx_for(id, id),
    onEnd: () => {
      if (d.name === "SUBSTITUTE_TO_MON") {
        Anim.setSubstitute(id, false);
      } else if (d.name === "MON_TO_SUBSTITUTE") {
        Anim.setSubstitute(id, true);
      }
      const pp = Anim.present(id);
      if (pp) pp.ox = 0;
      if (AnimSeq._waiting) advance();
    },
  }));
  launch_done();
}

// Lua: anim_seq.lua:601 -- pokefirered/src/battle_controller_player.c:2144
function run_switch_out(d: any): void {
  const id = ev_id(d, "battler", "side") ?? 1;
  const side = side_of(id);
  const p = Anim.present(id);
  const hide = (): void => {
    const pp = Anim.present(id);
    if (pp) {
      pp.visible = false;
      pp.switchedOut = true;
      pp.scale = 1;
      pp.sx = 1; pp.sy = 1;
    }
    const s = Anim.stage();
    if (s && s.healthbox && s.healthbox[id]) s.healthbox[id].visible = false;
    if (AnimSeq._waiting) advance();
  };
  if (d.slot != null) Anim.setShown(id, stand_in(id, d.slot));
  if (!p || p.visible === false) {
    AnimSeq._waiting = true;
    hide();
    return;
  }
  const out = (): void => {
    Anim.launchSpecial((side === "player") ? "SWITCH_OUT_PLAYER_MON" : "SWITCH_OUT_OPPONENT_MON", launch_opts(id, id, {
      ctx: ctx_for(id, id),
      onEnd: hide,
    }));
  };
  wait_anim();
  if (p.substitute) {
    const o = launch_opts(id, id, {
      ctx: ctx_for(id, id),
      onEnd: () => {
        Anim.setSubstitute(id, false);
        p.ox = 0;
        out();
      },
    });
    o.attackerSpecies = null; o.targetSpecies = null; o.speciesById = null;
    Anim.launchSpecial("SUBSTITUTE_TO_MON", o);
  } else {
    out();
  }
  launch_done();
}

// Lua: anim_seq.lua:647
function run_switch_in(d: any): void {
  const id = ev_id(d, "battler", "side") ?? 1;
  const side = side_of(id);
  const st = battle_state();
  const p = Anim.present(id);
  Anim.setShown(id, null);
  if (p) {
    p.switchedOut = null;
    // pokefirered/src/battle_gfx_sfx_util.c:997
    p.castformForm = null; p.castformMon = null;
    Anim.setSubstitute(id, false);
    const b = AnimCoords.battler(st, id);
    if (b && b.mon) {
      p.displayHp = tonumber(d.hp) ?? tonumber(b.mon.hp) ?? 0;
      p.displayMaxHp = tonumber(b.mon.maxHp) ?? 1;
      p.displayLevel = tonumber(b.mon.level) ?? 1;
    }
  }
  AnimSeq._waitSwitch = true;
  const started = SwitchSeq.beginEventSwitchIn(st, (id < 2) ? side : id, {
    battler: id,
    headless: Anim._headless,
    pushMsg: AnimSeq._pushMsg,
    onDone: () => {
      AnimSeq._waitSwitch = false;
    },
  });
  if (!truthy(started)) AnimSeq._waitSwitch = false;
  advance();
}

// Lua: anim_seq.lua:679
function run_step(step: any): void {
  if (!step) {
    finish_seq();
    return;
  }
  const kind = step.kind;
  const d = step.data ?? {};

  if (kind === "msg") {
    if (AnimSeq._pushMsg && d.text != null) AnimSeq._pushMsg(d.text, d.wait, d.id);
    AnimSeq._waiting = true;
    AnimSeq._waitingMsg = true;
    return;
  }
  if (kind === "faint_cry") {
    const id = ev_id(d, "battler", "side") ?? 1;
    const side = side_of(id);
    const sp = species_of(id);
    if (sp != null && !Anim._headless) {
      // pokefirered/src/battle_controller_player.c:2696
      try {
        Audio.playCry(sp, 5, (side === "player") ? -25 : 25);
      } catch { /* pcall */ }
    }
    advance();
    return;
  }
  if (kind === "pause") {
    if (!Anim._headless) pause(d.frames);
    advance();
    return;
  }
  if (kind === "move") return run_move(d);
  if (kind === "anim") {
    if (d.anim === "general") return run_general(d);
    if (d.anim === "status") return run_status(d);
    if (d.anim === "special") return run_special(d);
    advance();
    return;
  }
  if (kind === "hitfx") {
    // pokefirered/src/battle_controller_player.c:2658
    const id = ev_id(d, "battler", "side");
    if (d.effectiveness != null) play_effectiveness_se(d.effectiveness, id);
    wait_anim();
    Anim.blinkMon(id, { onComplete: () => { if (AnimSeq._waiting) advance(); } });
    launch_done();
    return;
  }
  if (kind === "hp") {
    wait_anim();
    Anim.tweenHp(ev_id(d, "battler", "side"), d.from, d.to, d.maxHp, {
      onComplete: () => { if (AnimSeq._waiting) advance(); },
    });
    launch_done();
    return;
  }
  if (kind === "faint") {
    const id = ev_id(d, "battler", "side") ?? 1;
    const p = Anim.present(id);
    if (p) {
      Anim.setSubstitute(id, false);
      p.blinkHidden = false;
    }
    wait_anim();
    Anim.faintMon(id, {
      onComplete: () => { if (AnimSeq._waiting) advance(); },
    });
    launch_done();
    return;
  }
  if (kind === "switch_out") return run_switch_out(d);
  if (kind === "switch_in") return run_switch_in(d);
  if (kind === "end") {
    AnimSeq._ended = { result: d.result, reason: d.reason };
    advance();
    return;
  }
  advance();
}

export const AnimSeq: Record<string, any> = {
  _steps: null as LuaTable,
  _i: 1,
  _waiting: false,
  _waitingMsg: false,
  _waitFrames: 0,
  _waitSwitch: false,
  _pushMsg: null as any,
  _pendingEff: null as any,
  _scene: true,
  _ended: null as any,
  _subLowered: {} as Record<number, boolean>,

  // Lua: anim_seq.lua:123
  reset(): void {
    AnimSeq._steps = null;
    AnimSeq._i = 1;
    AnimSeq._waiting = false;
    AnimSeq._waitingMsg = false;
    AnimSeq._waitFrames = 0;
    AnimSeq._waitSwitch = false;
    AnimSeq._pushMsg = null;
    AnimSeq._pendingEff = null;
    AnimSeq._ended = null;
    AnimSeq._subLowered = {};
    Anim.setSeqBusy(false);
  },

  // Lua: anim_seq.lua:137
  busy(): boolean {
    return AnimSeq._steps != null;
  },

  // Lua: anim_seq.lua:141
  ended(): any {
    return AnimSeq._ended;
  },

  // Lua: anim_seq.lua:217
  isMoveUsedId(id: unknown): boolean {
    return id != null && USED_IDS[id as string] === true;
  },

  // Lua: anim_seq.lua:225
  buildSteps(events: LuaTable, metaIn?: Record<string, any>): LuaTable {
    const meta = metaIn || {};
    const steps: LuaTable = [null];
    const add = (kind: string, data?: Record<string, any>): void => {
      steps[len(steps) + 1] = { kind, data: data ?? {} };
    };
    let lastMove: any = null;
    let lastMsgId: any = null;
    let deferredIn: any = null;
    let prevKind: any = null;
    const n = len(events);
    for (let i = 1; i <= n; i++) {
      const ev = events[i];
      const k = ev.kind;
      if (k === "msg") {
        if (is_miss(ev) && !lastMove && prevKind === "msg") {
          // pokefirered/data/battle_scripts_1.s:279
          add("pause", { frames: PAUSE_SHORT });
        }
        if (lastMove && SUBSTITUTE_IDS[ev.id ?? ""]) {
          // pokefirered/src/battle_script_commands.c:5300
          const a = ev_id(lastMove, "attackerId", "attacker") ?? 0;
          const t = ev_id(lastMove, "targetId", "target") ?? opposite(a);
          add("hitfx", { side: side_of(t), battler: t, effectiveness: meta.effectiveness ?? 1 });
        }
        add("msg", { text: ev.text, wait: ev.wait, id: ev.id });
        lastMsgId = ev.id;
        if (deferredIn) {
          add("switch_in", deferredIn);
          deferredIn = null;
        }
      } else if (k === "move") {
        lastMove = ev;
        add("move", {
          moveId: ev.moveId, attacker: ev.attacker, target: ev.target,
          attackerId: ev_id(ev, "attackerId", "attacker"), targetId: ev_id(ev, "targetId", "target"),
          turn: ev.turn ?? 0, calledBy: meta.calledBy, damage: ev.damage, power: ev.power,
        });
      } else if (k === "anim") {
        const d: Record<string, any> = { anim: ev.anim, name: ev.name, attacker: ev.attacker, target: ev.target, arg: ev.arg,
          attackerId: ev_id(ev, "attackerId", "attacker"), targetId: ev_id(ev, "targetId", "target") };
        if (ev.anim === "special" && (ev.name === "SUBSTITUTE_TO_MON" || ev.name === "MON_TO_SUBSTITUTE")) {
          if (ev.name === "SUBSTITUTE_TO_MON") {
            for (let j = i + 1; j <= n; j++) {
              if (events[j].kind === "move") { d.moveId = events[j].moveId; break; }
            }
          } else {
            d.moveId = lastMove ? lastMove.moveId : null;
          }
        }
        add("anim", d);
      } else if (k === "hit") {
        const b = ev_id(ev, "battler", "side");
        let eff: any = 1;
        if (ev.effectiveness != null) {
          eff = ev.effectiveness;
        } else if (prevKind === "move" || (lastMove && prevKind !== "hit" && prevKind !== "hp")) {
          eff = meta.effectiveness ?? 1;
        }
        add("hitfx", { side: ev.side, battler: b, effectiveness: eff });
        add("hp", { side: ev.side, battler: b, from: ev.from, to: ev.to, maxHp: ev.maxHp });
      } else if (k === "hp") {
        const b = ev_id(ev, "battler", "side");
        if (prevKind === "msg" && CONFUSION_IDS[lastMsgId ?? ""]) {
          // pokefirered/data/battle_scripts_1.s:3741
          add("hitfx", { side: ev.side, battler: b, effectiveness: 1 });
        }
        add("hp", { side: ev.side, battler: b, from: ev.from, to: ev.to, maxHp: ev.maxHp });
      } else if (k === "faint") {
        const b = ev_id(ev, "battler", "side");
        // pokefirered/data/battle_scripts_1.s:2810
        add("faint_cry", { side: ev.side, battler: b });
        add("pause", { frames: 64 });
        add("faint", { side: ev.side, battler: b });
      } else if (k === "switch_out") {
        add("switch_out", { side: ev.side, battler: ev_id(ev, "battler", "side"), reason: ev.reason });
      } else if (k === "switch") {
        const b = ev_id(ev, "battler", "side");
        add("switch_out", { side: ev.side, battler: b, reason: ev.reason, slot: ev.from });
        let hp: any = null;
        for (let j = i + 1; j <= n; j++) {
          const e2 = events[j];
          const b2 = ev_id(e2, "battler", "side");
          if ((e2.kind === "hp" || e2.kind === "hit") && b2 === b) { hp = e2.from; break; }
          if (e2.kind === "switch" && b2 === b) break;
        }
        const d = { side: ev.side, battler: b, slot: ev.to, hp, reason: ev.reason };
        if (ev.reason === "baton_pass" && events[i + 1] && events[i + 1].kind === "msg") {
          // pokefirered/data/battle_scripts_1.s:1690
          deferredIn = d;
        } else {
          add("switch_in", d);
        }
      } else if (k === "end") {
        add("end", { result: ev.result, reason: ev.reason });
      }
      prevKind = k;
    }
    if (deferredIn) add("switch_in", deferredIn);
    return steps;
  },

  // Lua: anim_seq.lua:353
  begin(result: any, pushMsg?: any): void {
    AnimSeq.reset();
    if (!result) return;
    AnimSeq._scene = scene_on();
    if (!truthy(result.events)) throw new Error("battle result has no event stream");
    start(AnimSeq.buildSteps(result.events, result), pushMsg);
  },

  // Lua: anim_seq.lua:360
  beginEvents(events: LuaTable, pushMsg?: any, meta?: Record<string, any>): void {
    AnimSeq.reset();
    AnimSeq._scene = scene_on();
    start(AnimSeq.buildSteps(events ?? seq(), meta), pushMsg);
  },

  // Lua: anim_seq.lua:760
  tickHitSe(): void { /* empty in Brian's */ },

  // Lua: anim_seq.lua:763
  update(): boolean {
    if (!AnimSeq._steps) return true;
    let guard = 0;
    while (guard < 256) {
      guard = guard + 1;
      if (AnimSeq._waitingMsg) {
        let pending: any = false;
        if (Ui.dialogPending) {
          pending = Ui.dialogPending();
        } else if (!Ui._headless) {
          pending = (Ui._showing === true) || (Ui._queue && len(Ui._queue) > 0);
        }
        if (truthy(pending)) return false;
        AnimSeq._waitingMsg = false;
        AnimSeq._waiting = false;
        advance();
      }
      if (AnimSeq._waitSwitch) {
        if (SwitchSeq.busy()) {
          if (!Anim.busy()) {
            if (Ui.pump()) SwitchSeq.update();
          }
          return false;
        }
        AnimSeq._waitSwitch = false;
      }
      if ((AnimSeq._waitFrames ?? 0) > 0) {
        AnimSeq._waitFrames = AnimSeq._waitFrames - 1;
        return false;
      }
      if (AnimSeq._waiting) {
        if (Anim.busy()) return false;
        flush_pending_eff();
        advance();
      }
      const step = AnimSeq._steps ? AnimSeq._steps[AnimSeq._i] : null;
      if (!step) {
        finish_seq();
        return true;
      }
      run_step(step);
      if (AnimSeq._waiting || AnimSeq._waitingMsg || AnimSeq._waitSwitch || (AnimSeq._waitFrames ?? 0) > 0) {
        return false;
      }
    }
    return false;
  },
};

export default AnimSeq;
