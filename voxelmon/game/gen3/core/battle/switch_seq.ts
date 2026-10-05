// Port of gen1recomp src/core/game3/battle/switch_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Mid-battle switch, withdraw, and send-out presentation sequencer.
// Handles dynamic withdraw strings, sprite tweens, cry audio, shiny checks, and hazard/ability triggers.
//
// Port notes:
// - package.loaded engine / battle / ui and the lazy requires (ui,
//   pokedude, intro_seq, anim_seq, abilities, trainers) are static imports.
// - Multiple returns are tuples: step_center -> [x, y];
//   Pokedude.sendOutOrigin -> [x, y].
// - pcall(fn, ad) in capture_events and the pcall'd SE calls are try/catch;
//   print -> console.log.
// - `Audio.isCryPlaying and Audio.isCryPlaying()`: kept as Brian's probe
//   (the port's Audio has no isCryPlaying, so it reads nil as in a Lua Audio
//   without it).
// - table.sort in entry_triggers uses lt.ts sort (a stable sort; see lt.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, sort, type LuaTable } from "../../platform/lt.ts";
import Anim from "./anim.ts";
import State from "./state.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
import ShinySeq from "./shiny_seq.ts";
import BattleText from "./battle_text.ts";
import Adapter from "./adapter.ts";
import MonAnimBattle from "./mon_anim_battle.ts";
import Engine from "./engine.ts";
import Abilities from "./abilities.ts";
import Pokedude from "./pokedude.ts";
import IntroSeq from "./intro_seq.ts";
import AnimSeq from "./anim_seq.ts";
import Trainers from "../scripting/trainers.ts";
import Ui from "./ui.ts";
import { Battle } from "../battle.ts";

type Fn = (...a: any[]) => any;

export interface SwitchSeqModule {
  _steps: LuaTable | null | undefined;
  _i: number;
  _waiting: boolean;
  _waitingMsg: boolean;
  _waitingCry: boolean;
  _pushMsg: Fn | null | undefined;
  _onDone: Fn | null | undefined;
  _headless: boolean;
  _st: any;
  _waitAnimSeq?: boolean;
  _waitingMonAnim?: LuaTable | null;
  reset(): void;
  busy(): boolean;
  stampSwitchIn(st: any): void;
  switchInFill(st: any, battler: any): any;
  beginPlayerSwitch(st: any, newSlot: number, opts?: any): boolean;
  beginSendOut(st: any, side: any, newSlot: number, opts?: any): boolean;
  returnText(st: any, id: number): string;
  beginDoubleSwitch(st: any, id: number, newSlot: number, opts?: any): boolean;
  beginEventSwitchIn(st: any, side: any, opts?: any): boolean;
  beginShiftSwitch(st: any, playerSlot: number, enemySlot: number, opts?: any): boolean;
  beginTrainerSlideIn(st: any, opts?: any): boolean;
  beginWallyThrow(st: any, opts?: any): boolean;
  update(): boolean;
}

export const SwitchSeq = {} as SwitchSeqModule;

SwitchSeq._steps = undefined;
SwitchSeq._i = 1;
SwitchSeq._waiting = false;
SwitchSeq._waitingMsg = false;
SwitchSeq._waitingCry = false;
SwitchSeq._pushMsg = undefined;
SwitchSeq._onDone = undefined;
SwitchSeq._headless = false;
SwitchSeq._st = undefined;

// Lua: switch_seq.lua:25
SwitchSeq.reset = function (): void {
  SwitchSeq._steps = undefined;
  SwitchSeq._i = 1;
  SwitchSeq._waiting = false;
  SwitchSeq._waitingMsg = false;
  SwitchSeq._waitingCry = false;
  SwitchSeq._pushMsg = undefined;
  SwitchSeq._onDone = undefined;
  SwitchSeq._st = undefined;
  SwitchSeq._waitAnimSeq = false;
  SwitchSeq._waitingMonAnim = undefined;
};

// Lua: switch_seq.lua:38
SwitchSeq.busy = function (): boolean {
  return SwitchSeq._steps != null;
};

// Lua: switch_seq.lua:42
function finish(): void {
  const cb = SwitchSeq._onDone;
  SwitchSeq._steps = undefined;
  SwitchSeq._i = 1;
  SwitchSeq._waiting = false;
  SwitchSeq._waitingMsg = false;
  SwitchSeq._waitingCry = false;
  SwitchSeq._onDone = undefined;
  SwitchSeq.stampSwitchIn(SwitchSeq._st);
  if (truthy(cb)) cb!();
}

// Lua: switch_seq.lua:54
function advance(): void {
  SwitchSeq._waiting = false;
  SwitchSeq._waitingMsg = false;
  SwitchSeq._waitingCry = false;
  SwitchSeq._i = SwitchSeq._i + 1;
}

// Lua: switch_seq.lua:61
function stage(): any {
  return Anim.stage();
}

// Lua: switch_seq.lua:65
function step_battler(st: any, d: any): any {
  if (d.id != null) return truthy(st) ? State.battler(st, d.id) : st;
  return truthy(st) ? st[truthy(d.side) ? d.side : "player"] : st;
}

// Lua: switch_seq.lua:70
function step_side(d: any): string {
  if (d.id != null) return State.sideOf(d.id);
  return truthy(d.side) ? d.side : "player";
}

// Lua: switch_seq.lua:75
function step_present(d: any): any {
  if (d.id == null) return Anim.present(truthy(d.side) ? d.side : "player");
  const p = Anim.present(d.id);
  if (truthy(p)) return p;
  if (d.id < 2) { const q = Anim.present(State.sideOf(d.id)); if (truthy(q)) return q; }
  return undefined;
}

// Lua: switch_seq.lua:80
function step_healthbox(s: any, d: any): any {
  const hb = truthy(s) ? s.healthbox : undefined;
  if (!truthy(hb)) return undefined;
  if (d.id == null) return hb[truthy(d.side) ? d.side : "player"];
  if (truthy(hb[d.id])) return hb[d.id];
  if (d.id < 2 && truthy(hb[State.sideOf(d.id)])) return hb[State.sideOf(d.id)];
  return undefined;
}

// Lua: switch_seq.lua:87
function step_center(st: any, d: any): [number, number] {
  if (d.id != null && truthy(Anim.coords)) {
    const a = Anim.coords(st, d.id);
    if (a !== null && typeof a === "object") return [a.x ?? a[1], a.y ?? a[2]];
    if (truthy(a)) return [a, undefined as any];
  }
  const base = (step_side(d) === "player") ? Anim.PLAYER_MON : Anim.ENEMY_MON;
  return [base.x, base.y];
}

// Lua: switch_seq.lua:97
function opposing(st: any, battler: any): any {
  return (battler.side === "player") ? st.enemy : st.player;
}

// Lua: switch_seq.lua:101
function hp_of(b: any): number {
  return tonumber(truthy(b) && truthy(b.mon) ? b.mon.hp : undefined) ?? 0;
}

// pokefirered/src/battle_script_commands.c:5998
// Lua: switch_seq.lua:106
function hp_thresholds(st: any, battler: any): number {
  if (truthy(st.double)) return 0;
  const opp = opposing(st, battler);
  const hp = hp_of(opp);
  const maxHp = tonumber(truthy(opp) && truthy(opp.mon) ? opp.mon.maxHp : undefined) ?? 1;
  let result = Math.floor(hp * 100 / maxHp);
  if (result === 0) result = 1;
  if (result > 69 || hp === 0) return 0;
  if (result > 39) return 1;
  if (result > 9) return 2;
  return 3;
}

// pokefirered/src/battle_script_commands.c:6025
// Lua: switch_seq.lua:120
function hp_thresholds2(st: any, battler: any): number {
  if (truthy(st.double)) return 0;
  const opp = opposing(st, battler);
  let switchout = truthy(st.hpOnSwitchout) ? st.hpOnSwitchout[truthy(opp) ? opp.side : opp] : undefined;
  if (!truthy(switchout)) return 0;
  // pokefirered/src/battle_script_commands.c:6029
  switchout = switchout % 256;
  const hp = hp_of(opp);
  if (hp >= switchout) return 0;
  const result = Math.floor((switchout - hp) * 100 / switchout);
  if (result <= 29) return 1;
  if (result <= 69) return 2;
  return 3;
}

// pokefirered/src/battle_script_commands.c:5022
// Lua: switch_seq.lua:136
SwitchSeq.stampSwitchIn = function (st: any): void {
  if (!truthy(st)) return;
  st.hpOnSwitchout = st.hpOnSwitchout ?? {};
  for (const [, b] of ipairs<any>(State.present(st))) {
    st.hpOnSwitchout[b.side] = hp_of(b);
  }
};

/** `st and st.linkNames and st.linkNames[State.idOf(battler)] or nil` */
function link_name(st: any, battler: any): any {
  if (!truthy(st) || !truthy(st.linkNames)) return undefined;
  const v = st.linkNames[State.idOf(battler) as number];
  return truthy(v) ? v : undefined;
}

// pokefirered/src/battle_message.c:1628
// Lua: switch_seq.lua:145
function withdraw_text(st: any, battler: any): string {
  return BattleText.get(BattleText.RETURNMON, Adapter.fill(st, {
    side: battler.side, hpScale: hp_thresholds2(st, battler), buff1: State.displayName(battler),
    linkScrTrainerName: link_name(st, battler),
  }));
}

// pokefirered/src/battle_message.c:1655
// Lua: switch_seq.lua:153
SwitchSeq.switchInFill = function (st: any, battler: any): any {
  return Adapter.fill(st, {
    side: battler.side, hpScale: hp_thresholds(st, battler), buff1: State.displayName(battler),
    switchBattler: State.idOf(battler),
    linkScrTrainerName: link_name(st, battler),
  });
};

// Lua: switch_seq.lua:161
function switch_in_text(st: any, battler: any): string {
  return BattleText.get(BattleText.SWITCHINMON, SwitchSeq.switchInFill(st, battler));
}

// Lua: switch_seq.lua:165
function apply_entry_triggers(st: any, side: any, pushMsg: Fn | null | undefined, opts?: any): void {
  if (!truthy(st)) return;
  opts = opts ?? {};
  const b = st[side];
  if (!truthy(b) || !truthy(b.mon) || (tonumber(b.mon.hp) ?? 0) <= 0) return;

  // Hazards: Spikes
  const sideState = (side === "player") ? st.playerSide : st.enemySide;
  const hazards = (truthy(sideState) ? sideState.hazards : undefined) ?? {};
  const spikesLayers = tonumber(truthy(hazards.spikes) ? hazards.spikes : hazards.SPIKES) ?? 0;
  if (!truthy(opts.noSpikes) && spikesLayers > 0 && truthy(b) && truthy(b.mon)) {
    const isFlying = (b.type1 === 2 || b.type2 === 2 || b.type1 === "FLYING" || b.type2 === "FLYING");
    const hasLevitate = (b.ability === "LEVITATE" || b.ability === 26);
    if (!isFlying && !hasLevitate) {
      const maxHp = tonumber(b.mon.maxHp) ?? 1;
      const fraction = (spikesLayers === 1) ? 8 : (spikesLayers === 2 ? 6 : 4);
      const dmg = Math.max(1, Math.floor(maxHp / fraction));
      State.applyHpLoss(b, dmg);
      const msg = BattleText.get("STRINGID_PKMNHURTBYSPIKES", Adapter.fill(st, { scrActive: b }));
      if (truthy(pushMsg)) pushMsg!(msg);
      const p = Anim.present(side);
      if (truthy(p)) {
        Anim.tweenHp(side, truthy(p.displayHp) ? p.displayHp : maxHp, b.mon.hp, maxHp);
      }
    }
  }

  // Ability: Intimidate (ability 22 or "INTIMIDATE")
  if (!truthy(opts.noIntimidate) && (b.ability === 22 || b.ability === "INTIMIDATE") && (tonumber(b.mon.hp) ?? 0) > 0) {
    const oppSide = (side === "player") ? "enemy" : "player";
    const opp = st[oppSide];
    if (truthy(opp) && truthy(opp.mon) && (tonumber(opp.mon.hp) ?? 0) > 0) {
      if (opp.ability === "CLEAR_BODY" || opp.ability === 29 || opp.ability === "WHITE_SMOKE" || opp.ability === 73 || truthy(opp.substitute)) {
        // Immune to Intimidate
      } else {
        const cur = (truthy(opp.stages) ? opp.stages.attack : undefined) ?? 0;
        if (cur > -6) {
          opp.stages.attack = Math.max(-6, cur - 1);
          const msg = BattleText.get("STRINGID_PKMNCUTSATTACKWITH",
            Adapter.fill(st, { scrActive: b, def: opp, scrActiveAbility: b.ability }));
          if (truthy(pushMsg)) pushMsg!(msg);
        }
      }
    }
  }
}

// Lua: switch_seq.lua:212
function battle_adapter(): any {
  // package.loaded["src.core.game3.battle"]
  return truthy(Battle) ? Battle._adapter : undefined;
}

// Lua: switch_seq.lua:217
function capture_events(fn: (ad: any) => void): LuaTable | undefined {
  const ad = battle_adapter();
  if (!truthy(ad)) return undefined;
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = function (): void { /* no-op */ };
  let ok = true, fnErr: any;
  try { fn(ad); } catch (e) { ok = false; fnErr = e instanceof Error ? e.message : e; }
  ad._say = prev;
  if (!ok) {
    console.log("[game3/battle] switch effect failed: " + tostring(fnErr));
    return [null];
  }
  return ad.eventsSince(mark);
}

// pokefirered/src/battle_script_commands.c:9197
// Lua: switch_seq.lua:233
function switch_out_effects(st: any, battler: any): void {
  // package.loaded["src.core.game3.battle.engine"]
  if (!(truthy(Engine) && truthy(Engine.switchOutEffects) && truthy(battler))) return;
  capture_events((ad) => { Engine.switchOutEffects(st, ad, battler); });
}

// Lua: switch_seq.lua:239
function fallback_entry(st: any, sides: LuaTable, pushMsg: Fn | null | undefined, opts?: any): void {
  opts = opts ?? {};
  const deferred = opts.deferred ?? [null];
  if (!truthy(opts.deferIntimidate) && len(deferred) === 0) {
    for (const [, side] of ipairs(sides)) apply_entry_triggers(st, side, pushMsg);
    return;
  }
  for (const [, side] of ipairs(sides)) apply_entry_triggers(st, side, pushMsg, { noIntimidate: true });
  if (truthy(opts.deferIntimidate)) return;
  for (const [, side] of ipairs(deferred)) apply_entry_triggers(st, side, pushMsg, { noSpikes: true });
  for (const [, side] of ipairs(sides)) apply_entry_triggers(st, side, pushMsg, { noSpikes: true });
}

// pokefirered/src/battle_script_commands.c:4960
// Lua: switch_seq.lua:253
function engine_entry_events(st: any, sides: LuaTable, opts?: any): LuaTable | undefined {
  opts = opts ?? {};
  // package.loaded["src.core.game3.battle.engine"]
  if (!(truthy(Engine) && truthy(Engine.switchInEffects) && truthy(battle_adapter()))) return undefined;
  return capture_events((ad) => {
    for (const [, side] of ipairs<any>(sides)) {
      const b = truthy(st) ? ((typeof side === "number") ? State.battler(st, side) : st[side]) : st;
      if (truthy(b) && truthy(b.mon) && (tonumber(b.mon.hp) ?? 0) > 0) {
        Engine.switchInEffects(st, ad, b, { spikes: true, deferIntimidate: opts.deferIntimidate });
      }
    }
    if (truthy(opts.deferred) && !truthy(opts.deferIntimidate)) {
      // pokefirered/src/battle_util.c:1209
      for (let i = 1; i <= 4; i++) {
        if (!(Abilities.runIntimidate(ad) || Abilities.runTrace(ad))) break;
      }
    }
  });
}

// Lua: switch_seq.lua:274
function headless_entry(st: any, sides: LuaTable, opts?: any): void {
  const evs = engine_entry_events(st, sides, opts);
  if (evs == null) {
    fallback_entry(st, sides, SwitchSeq._pushMsg, opts);
    return;
  }
  for (const [, e] of ipairs<any>(evs)) {
    if (e.kind === "msg" && truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(e.text);
  }
  Anim.syncDisplayFromState(st);
}

/** Install the common sequence fields (the first lines of every begin*). */
function begin_common(st: any, opts: any): void {
  SwitchSeq.reset();
  SwitchSeq._st = st;
  SwitchSeq._headless = truthy(opts.headless) ? true : false;
  SwitchSeq._pushMsg = opts.pushMsg;
  SwitchSeq._onDone = opts.onDone;
}

// Lua: switch_seq.lua:286
SwitchSeq.beginPlayerSwitch = function (st: any, newSlot: number, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);

  const oldBattler = st.player;
  const withdrawMsg = withdraw_text(st, oldBattler);

  if (SwitchSeq._headless) {
    if (truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(withdrawMsg);
    switch_out_effects(st, oldBattler);
    State.trackParticipant(st, st.enemy, (truthy(oldBattler) && truthy(oldBattler.partyIndex)) ? oldBattler.partyIndex : 1);
    State.syncBattlerToParty(st.player, st.playerParty);
    State.wipeVolatilesAndStages(st.player, { batonPass: opts.batonPass });
    st.player = State.makeBattler(st.playerParty[newSlot], "player", { partyIndex: newSlot, st });
    State.trackParticipant(st, st.enemy, newSlot);
    Anim.syncDisplayFromState(st);
    if (truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(switch_in_text(st, st.player));
    headless_entry(st, seq("player"));
    finish();
    return false;
  }

  const steps = seq(
    { kind: "msg", data: { text: withdrawMsg } },
    { kind: "withdraw", data: { side: "player" } },
    { kind: "swap_data", data: { side: "player", newSlot, batonPass: opts.batonPass } },
    { kind: "msg_sendout", data: { side: "player" } },
    { kind: "sendout_player", data: { slot: newSlot } },
    { kind: "shiny_check", data: { side: "player" } },
    { kind: "cry", data: { side: "player" } },
    { kind: "healthbox", data: { side: "player" } },
    { kind: "entry_triggers", data: { side: "player" } },
  );

  SwitchSeq._steps = steps;
  SwitchSeq._i = 1;
  return true;
};

// Lua: switch_seq.lua:329
SwitchSeq.beginSendOut = function (st: any, side: any, newSlot: number, opts?: any): boolean {
  opts = opts ?? {};
  side = truthy(side) ? side : "player";
  begin_common(st, opts);

  if (SwitchSeq._headless) {
    if (side === "player") {
      st.player = State.makeBattler(st.playerParty[newSlot], "player", { partyIndex: newSlot, st });
      State.trackParticipant(st, st.enemy, newSlot);
      Anim.syncDisplayFromState(st);
      if (truthy(SwitchSeq._pushMsg)) {
        SwitchSeq._pushMsg!(switch_in_text(st, st.player));
      }
    } else {
      st.enemy = State.makeBattler(st.foeParty[newSlot], "enemy", { partyIndex: newSlot, st, state: st });
      State.opponentSwitchInResetSentPokes(st, st.enemy);
      Anim.syncDisplayFromState(st);
      if (truthy(SwitchSeq._pushMsg)) {
        SwitchSeq._pushMsg!(switch_in_text(st, st.enemy));
      }
    }
    headless_entry(st, seq(side));
    finish();
    return false;
  }

  let steps: LuaTable;
  if (side === "player") {
    steps = seq(
      { kind: "swap_data", data: { side: "player", newSlot } },
      { kind: "msg_sendout", data: { side: "player" } },
      { kind: "sendout_player", data: { slot: newSlot } },
      { kind: "shiny_check", data: { side: "player" } },
      { kind: "cry", data: { side: "player" } },
      { kind: "healthbox", data: { side: "player" } },
      { kind: "entry_triggers", data: { side: "player" } },
    );
  } else {
    steps = seq(
      { kind: "swap_data", data: { side: "enemy", newSlot } },
      { kind: "msg_sendout", data: { side: "enemy" } },
      { kind: "sendout_enemy", data: { slot: newSlot } },
      { kind: "shiny_check", data: { side: "enemy" } },
      { kind: "cry", data: { side: "enemy" } },
      { kind: "healthbox", data: { side: "enemy" } },
      { kind: "entry_triggers", data: { side: "enemy" } },
    );
  }

  SwitchSeq._steps = steps;
  SwitchSeq._i = 1;
  return true;
};

// Lua: switch_seq.lua:387
SwitchSeq.returnText = function (st: any, id: number): string {
  return withdraw_text(st, State.battler(st, id));
};

// pokefirered/data/battle_scripts_1.s:3046
// Lua: switch_seq.lua:392
SwitchSeq.beginDoubleSwitch = function (st: any, id: number, newSlot: number, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);
  const side = State.sideOf(id);
  let withdrawMsg: string | undefined;
  if (truthy(opts.withdraw) && !truthy(opts.noWithdrawMsg)) {
    withdrawMsg = SwitchSeq.returnText(st, id);
  }
  const reason = truthy(opts.reason) ? opts.reason : (truthy(opts.withdraw) ? "switch" : "replace");

  if (SwitchSeq._headless) {
    if (truthy(withdrawMsg) && truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(withdrawMsg);
    // package.loaded["src.core.game3.battle.engine"]
    const party = (side === "player") ? st.playerParty : st.foeParty;
    if (truthy(Engine) && truthy(Engine.performSwitch) && truthy(battle_adapter()) && truthy(party) && truthy(party[newSlot])) {
      capture_events((ad) => {
        Engine.performSwitch(st, ad, id, newSlot, { batonPass: opts.batonPass, reason });
      });
    }
    Anim.syncDisplayFromState(st);
    const nb = State.battler(st, id);
    if (truthy(SwitchSeq._pushMsg)) {
      SwitchSeq._pushMsg!(switch_in_text(st, nb));
    }
    headless_entry(st, seq(id));
    finish();
    return false;
  }

  const steps: LuaTable = [null];
  if (truthy(withdrawMsg)) {
    steps[len(steps) + 1] = { kind: "msg", data: { text: withdrawMsg } };
  }
  if (truthy(opts.withdraw)) {
    steps[len(steps) + 1] = { kind: "withdraw", data: { id } };
  }
  steps[len(steps) + 1] = { kind: "swap_data", data: { id, newSlot, batonPass: opts.batonPass, reason } };
  steps[len(steps) + 1] = { kind: "msg_sendout", data: { id } };
  steps[len(steps) + 1] = { kind: (side === "player") ? "sendout_player" : "sendout_enemy", data: { id, slot: newSlot } };
  steps[len(steps) + 1] = { kind: "shiny_check", data: { id } };
  steps[len(steps) + 1] = { kind: "cry", data: { id } };
  steps[len(steps) + 1] = { kind: "healthbox", data: { id } };
  steps[len(steps) + 1] = { kind: "entry_triggers", data: { id } };
  SwitchSeq._steps = steps;
  SwitchSeq._i = 1;
  return true;
};

// pokefirered/src/battle_controller_player.c:2105
// Lua: switch_seq.lua:445
SwitchSeq.beginEventSwitchIn = function (st: any, side: any, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);
  if (SwitchSeq._headless) {
    finish();
    return false;
  }
  let id: number | undefined = tonumber(opts.battler) ?? ((typeof side === "number") ? side : undefined);
  if (id != null && !(truthy(st) && truthy(st.double)) && id < 2) id = undefined;
  if (typeof side === "number") side = State.sideOf(side);
  const d = (id != null) ? { id } : { side };
  SwitchSeq._steps = seq(
    { kind: (side === "player") ? "sendout_player" : "sendout_enemy", data: d },
    { kind: "shiny_check", data: d },
    { kind: "cry", data: d },
    { kind: "healthbox", data: d },
  );
  SwitchSeq._i = 1;
  return true;
};

// pokefirered/data/battle_scripts_1.s:2856
// Lua: switch_seq.lua:471
SwitchSeq.beginShiftSwitch = function (st: any, playerSlot: number, enemySlot: number, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);

  const oldBattler = st.player;
  const withdrawMsg = withdraw_text(st, oldBattler);

  if (SwitchSeq._headless) {
    if (truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(withdrawMsg);
    switch_out_effects(st, oldBattler);
    State.syncBattlerToParty(st.player, st.playerParty);
    State.wipeVolatilesAndStages(st.player);
    st.player = State.makeBattler(st.playerParty[playerSlot], "player", { partyIndex: playerSlot, st, state: st });
    if (truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(switch_in_text(st, st.player));
    headless_entry(st, seq("player"), { deferIntimidate: true });
    // pokefirered/src/battle_script_commands.c:5945
    State.resetSentPokes(st);
    st.enemy = State.makeBattler(st.foeParty[enemySlot], "enemy", { partyIndex: enemySlot, st });
    // pokefirered/src/battle_util.c:254
    State.opponentSwitchInResetSentPokes(st, st.enemy);
    Anim.syncDisplayFromState(st);
    if (truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(switch_in_text(st, st.enemy));
    headless_entry(st, seq("enemy"), { deferred: seq("player") });
    finish();
    return false;
  }

  const steps = seq(
    { kind: "msg", data: { text: withdrawMsg } },
    { kind: "withdraw", data: { side: "player" } },
    { kind: "swap_data", data: { side: "player", newSlot: playerSlot, isShift: true, reason: "shift" } },
    { kind: "msg_sendout", data: { side: "player" } },
    { kind: "sendout_player", data: { slot: playerSlot } },
    { kind: "shiny_check", data: { side: "player" } },
    { kind: "cry", data: { side: "player" } },
    { kind: "healthbox", data: { side: "player" } },
    { kind: "entry_triggers", data: { side: "player", deferIntimidate: true } },
    // pokefirered/data/battle_scripts_1.s:2874
    { kind: "swap_data", data: { side: "enemy", newSlot: enemySlot, reason: "shift" } },
    { kind: "msg_sendout", data: { side: "enemy" } },
    { kind: "sendout_enemy", data: { slot: enemySlot } },
    { kind: "shiny_check", data: { side: "enemy" } },
    { kind: "cry", data: { side: "enemy" } },
    { kind: "healthbox", data: { side: "enemy" } },
    { kind: "entry_triggers", data: { side: "enemy", deferred: seq("player") } },
  );

  SwitchSeq._steps = steps;
  SwitchSeq._i = 1;
  return true;
};

/** Retail defeat slide-in: Front sprite of defeated enemy trainer slides in from right before defeat speech. */
// Lua: switch_seq.lua:528
SwitchSeq.beginTrainerSlideIn = function (st: any, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);

  if (SwitchSeq._headless) {
    finish();
    return false;
  }

  const steps: LuaTable = seq(
    { kind: "trainer_slide_in", data: { side: "enemy", picId: opts.picId } },
  );
  if (truthy(opts.trainerB)) {
    // pokeemerald/data/battle_scripts_1.s:2929
    if (truthy(opts.loseTextA) && opts.loseTextA !== "") {
      steps[len(steps) + 1] = { kind: "msg", data: { text: opts.loseTextA } };
    }
    steps[len(steps) + 1] = { kind: "trainer_slide_out", data: {} };
    steps[len(steps) + 1] = { kind: "trainer_slide_in", data: { side: "enemy", picId: opts.trainerB.pic } };
  }
  SwitchSeq._steps = steps;
  SwitchSeq._i = 1;
  return true;
};

// pokeemerald/data/battle_scripts_2.s:193
// Lua: switch_seq.lua:558
SwitchSeq.beginWallyThrow = function (st: any, opts?: any): boolean {
  opts = opts ?? {};
  begin_common(st, opts);
  const retText = withdraw_text(st, st.player);
  const nowText = BattleText.get("STRINGID_YOUTHROWABALLNOWRIGHT", Adapter.fill(st));
  if (SwitchSeq._headless) {
    if (truthy(SwitchSeq._pushMsg)) {
      SwitchSeq._pushMsg!(retText);
      SwitchSeq._pushMsg!(nowText);
    }
    finish();
    return false;
  }
  SwitchSeq._steps = seq(
    { kind: "msg", data: { text: retText } },
    { kind: "withdraw", data: { side: "player" } },
    { kind: "player_trainer_slide_in", data: { backPic: opts.backPic } },
    { kind: "msg", data: { text: nowText } },
  );
  SwitchSeq._i = 1;
  return true;
};

// Lua: switch_seq.lua:585
function wait_busy(): void {
  SwitchSeq._waiting = true;
}

// Lua: switch_seq.lua:589
function run_step(step: any): void {
  if (!truthy(step)) return;
  const kind = step.kind;
  const d = step.data ?? {};
  const s = stage();
  const st = SwitchSeq._st;

  if (kind === "mon_anim") {
    for (const [, key] of ipairs(d.ids ?? [null])) {
      MonAnimBattle.start(key, d.kind, { st, noCry: d.noCry });
    }
    advance();
    return;
  }

  if (kind === "mon_anim_wait") {
    SwitchSeq._waitingMonAnim = d.ids;
    return;
  }

  if (kind === "msg") {
    if (truthy(SwitchSeq._pushMsg) && truthy(d.text)) {
      SwitchSeq._pushMsg!(d.text);
    }
    SwitchSeq._waiting = true;
    SwitchSeq._waitingMsg = true;
    return;
  }

  if (kind === "msg_sendout") {
    const text = switch_in_text(st, step_battler(st, d));
    if (!SwitchSeq._headless) {
      // pokefirered/data/battle_scripts_1.s:2879
      Ui.pushTimed(text, 0);
    } else if (truthy(SwitchSeq._pushMsg)) {
      SwitchSeq._pushMsg!(text);
    }
    SwitchSeq._waiting = true;
    SwitchSeq._waitingMsg = true;
    return;
  }

  if (kind === "withdraw") {
    const p = step_present(d);
    const hb = step_healthbox(s, d);
    if (truthy(hb)) hb.visible = false;
    try { Audio.playSe(SE.SE_BALL_OPEN); } catch { /* pcall */ }
    wait_busy();
    Anim.tweenStage(12, (u: number) => {
      if (truthy(p)) {
        p.scale = Math.max(0.01, 1 - u);
      }
    }, () => {
      if (truthy(p)) {
        p.visible = false;
        p.scale = 1;
      }
      advance();
    });
    return;
  }

  if (kind === "swap_data") {
    const side = step_side(d);
    const newSlot = truthy(d.newSlot) ? d.newSlot : 1;
    // package.loaded["src.core.game3.battle.engine"]
    const party = truthy(st) ? ((side === "player") ? st.playerParty : st.foeParty) : st;
    const pres = step_present(d);
    // pokefirered/src/battle_gfx_sfx_util.c:997
    if (truthy(pres)) { pres.castformForm = undefined; pres.castformMon = undefined; }
    if (truthy(Engine) && truthy(Engine.performSwitch) && truthy(battle_adapter()) && truthy(step_battler(st, d)) && truthy(party) && truthy(party[newSlot])) {
      capture_events((ad) => {
        Engine.performSwitch(st, ad, d.id != null ? d.id : side, newSlot,
          { batonPass: d.batonPass, reason: truthy(d.reason) ? d.reason : "switch", isShift: d.isShift });
      });
      Anim.syncDisplayFromState(st);
      advance();
      return;
    }
    switch_out_effects(st, truthy(st) ? st[side] : st);
    const isShift = truthy(d.isShift) || d.reason === "shift";
    if (side === "player") {
      if (truthy(st) && truthy(st.player)) {
        if (!isShift) {
          State.trackParticipant(st, st.enemy, truthy(st.player.partyIndex) ? st.player.partyIndex : 1);
        }
        State.syncBattlerToParty(st.player, st.playerParty);
        State.wipeVolatilesAndStages(st.player, { batonPass: d.batonPass });
      }
      st.player = State.makeBattler(st.playerParty[newSlot], "player", { partyIndex: newSlot, st });
      if (isShift) {
        // pokefirered/src/battle_script_commands.c:5945
        State.resetSentPokes(st);
      } else {
        State.trackParticipant(st, st.enemy, newSlot);
      }
    } else {
      if (truthy(st) && truthy(st.enemy)) {
        State.syncBattlerToParty(st.enemy, st.foeParty);
        State.wipeVolatilesAndStages(st.enemy);
      }
      st.enemy = State.makeBattler(st.foeParty[newSlot], "enemy", { partyIndex: newSlot, st, state: st });
      State.opponentSwitchInResetSentPokes(st, st.enemy);
    }
    Anim.syncDisplayFromState(st);
    advance();
    return;
  }

  if (kind === "sendout_player") {
    const [pcx, pcy] = step_center(st, d.id != null ? d : { side: "player" });
    s.ball.visible = true;
    s.ball.frame = 0;
    s.ball.rot = 0;
    s.ball.side = "player";
    s.ball.ballId = Anim.ballIdOf(d.id != null ? d.id : "player");
    const [sx, sy] = Pokedude.sendOutOrigin(st);
    s.ball.x = sx;
    s.ball.y = sy;
    try { Audio.playSe(SE.SE_BALL_THROW, { pan: -64 }); } catch { /* pcall */ }
    wait_busy();
    Anim.tweenStage(25, (u: number, t: any) => {
      const f = truthy(t.frames) ? t.frames : (u * 25);
      const tx = pcx, ty = pcy + 24;
      s.ball.x = sx + (tx - sx) * u;
      s.ball.y = sy + (ty - sy) * u + (-30 * 4 * u * (1 - u));
      s.ball.rot = f * ((25 / 256) * Math.PI * 2);
    }, () => {
      s.ball.frame = 1;
      s.ball.rot = 0;
      try { Audio.playSe(SE.SE_BALL_OPEN, { pan: -64 }); } catch { /* pcall */ }
      Anim.ballOpen(d.id != null ? d.id : "player", s.ball.x, s.ball.y);
      const p = step_present(d.id != null ? d : { side: "player" }) ?? {};
      p.visible = true;
      p.ox = 0;
      p.oy = 16;
      p.scale = 0.16;
      p.darken = 0;
      Anim.tweenStage(12, (u: number) => {
        p.oy = 16 * (1 - u);
        p.scale = 0.16 + 0.84 * u;
        s.ball.frame = (u < 0.5) ? 1 : 2;
      }, () => {
        p.oy = 0;
        p.scale = 1;
        s.ball.visible = false;
        s.ball.rot = 0;
        advance();
      });
    });
    return;
  }

  if (kind === "sendout_enemy") {
    const [cx, cy] = step_center(st, d.id != null ? d : { side: "enemy" });
    s.ball.visible = true;
    s.ball.frame = 0;
    s.ball.side = "enemy";
    s.ball.ballId = Anim.ballIdOf(d.id != null ? d.id : "enemy");
    s.ball.x = cx;
    s.ball.y = cy + 24;
    wait_busy();
    Anim.tweenStage(16, () => { /* no-op */ }, () => {
      s.ball.frame = 1;
      try { Audio.playSe(SE.SE_BALL_OPEN, { pan: 63 }); } catch { /* pcall */ }
      Anim.ballOpen(d.id != null ? d.id : "enemy", s.ball.x, s.ball.y);
      const p = step_present(d.id != null ? d : { side: "enemy" }) ?? {};
      p.visible = true;
      p.ox = 0;
      p.oy = 16;
      p.scale = 0.16;
      p.darken = 0;
      Anim.tweenStage(12, (u: number) => {
        p.oy = 16 * (1 - u);
        p.scale = 0.16 + 0.84 * u;
        s.ball.frame = (u < 0.5) ? 1 : 2;
      }, () => {
        p.oy = 0;
        p.scale = 1;
        s.ball.visible = false;
        advance();
      });
    });
    return;
  }

  if (kind === "shiny_check") {
    const b = step_battler(st, d);
    if (ShinySeq.start(b, d.id != null ? d.id : (truthy(d.side) ? d.side : "enemy"), () => {
      advance();
    })) {
      wait_busy();
      return;
    }
    advance();
    return;
  }

  if (kind === "cry") {
    const side = step_side(d);
    const b = step_battler(st, d);
    const sp = truthy(b) ? (truthy(b.species) ? b.species
      : (truthy(b.mon) ? (truthy(b.mon.species) ? b.mon.species : b.mon.speciesId) : b.mon)) : b;
    if (truthy(sp)) {
      // pokefirered/src/pokeball.c:782
      Audio.playCry(sp, IntroSeq.releaseCryMode(b.mon), (side === "player") ? -25 : 25);
    }
    SwitchSeq._waiting = true;
    SwitchSeq._waitingCry = true;
    return;
  }

  if (kind === "healthbox") {
    const side = step_side(d);
    const hb = step_healthbox(s, d) ?? {};
    const from = (side === "player") ? 115 : -115;
    hb.visible = true;
    hb.ox = from;
    wait_busy();
    Anim.tweenStage(20, (u: number) => {
      hb.ox = from * (1 - u);
    }, () => {
      hb.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "entry_triggers") {
    let sides: LuaTable = truthy(d.sides) ? d.sides : seq(truthy(d.side) ? d.side : "player");
    if (d.id != null) sides = seq(d.id);
    if (len(sides) > 1) {
      const sorted: LuaTable = [null];
      for (let i = 1; i <= len(sides); i++) sorted[i] = sides[i];
      const speedOf = (k: any): number => {
        const x = truthy(st) ? st[k] : undefined;
        if (!truthy(x)) return 0;
        return (truthy(x.speed) ? x.speed : (truthy(x.mon) ? x.mon.speed : x.mon)) || 0;
      };
      sort(sorted, (a: any, bSide: any) => speedOf(a) > speedOf(bSide));
      sides = sorted;
    }
    const entryOpts = { deferIntimidate: d.deferIntimidate, deferred: d.deferred };
    const evs = engine_entry_events(st, sides, entryOpts);
    if (evs == null) {
      fallback_entry(st, sides, SwitchSeq._pushMsg, entryOpts);
    } else if (len(evs) > 0) {
      if (!AnimSeq.busy()) {
        AnimSeq.beginEvents(evs, (text: any, wait: any) => { Ui.pushTimed(text, tonumber(wait) ?? 64); });
        SwitchSeq._waitAnimSeq = true;
        advance();
        return;
      }
      for (const [, e] of ipairs<any>(evs)) {
        if (e.kind === "msg" && truthy(SwitchSeq._pushMsg)) SwitchSeq._pushMsg!(e.text);
      }
      Anim.syncDisplayFromState(st);
    }
    advance();
    return;
  }

  if (kind === "trainer_slide_in") {
    const p = Anim.present("enemy");
    if (truthy(p)) p.visible = false;
    const hb = truthy(s.healthbox) ? s.healthbox.enemy : undefined;
    if (truthy(hb)) hb.visible = false;
    if (truthy(st) && truthy(st.double)) {
      for (const [, id] of ipairs<number>(seq(1, 3))) {
        const pp = step_present({ id });
        if (truthy(pp)) pp.visible = false;
        const hh = step_healthbox(s, { id });
        if (truthy(hh)) hh.visible = false;
      }
    }
    const info = truthy(st) && truthy(st.trainerId) ? Trainers.info(st.trainerId) : undefined;
    const picId = (truthy(d.picId) ? d.picId : undefined)
      ?? (truthy(st) && truthy(st.trainerPicId) ? st.trainerPicId : undefined)
      ?? (truthy(info) && truthy(info.pic) ? info.pic : undefined) ?? 0;
    s.trainer.enemy.visible = true;
    s.trainer.enemy.picId = picId;
    s.trainer.enemy.x = undefined; s.trainer.enemy.pic2 = undefined; s.trainer.enemy.x2 = undefined;
    s.trainer.enemy.ox = 240;
    wait_busy();
    Anim.tweenStage(35, (u: number) => {
      s.trainer.enemy.ox = 240 * (1 - u);
    }, () => {
      s.trainer.enemy.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "player_trainer_slide_in") {
    // pokeemerald/src/battle_controller_wally.c:1050
    const tp = s.trainer.player;
    if (d.backPic != null) tp.gender = d.backPic;
    tp.visible = true;
    tp.frame = 0;
    tp.ox = -96;
    wait_busy();
    Anim.tweenStage(48, (u: number) => {
      tp.ox = -96 * (1 - u);
    }, () => {
      tp.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "trainer_slide_out") {
    // pokeemerald/src/battle_controller_opponent.c:1397
    wait_busy();
    Anim.tweenStage(35, (u: number) => {
      s.trainer.enemy.ox = 104 * u;
    }, () => {
      s.trainer.enemy.visible = false;
      s.trainer.enemy.ox = 0;
      advance();
    });
    return;
  }

  advance();
}

// Lua: switch_seq.lua:915
SwitchSeq.update = function (): boolean {
  if (!truthy(SwitchSeq._steps)) return true;
  if (SwitchSeq._i === 1) SwitchSeq._steps = MonAnimBattle.switchSteps(SwitchSeq._steps);

  if (truthy(SwitchSeq._waitingMonAnim)) {
    if (MonAnimBattle.busy(SwitchSeq._waitingMonAnim)) return false;
    SwitchSeq._waitingMonAnim = undefined;
    advance();
  }

  if (SwitchSeq._waitAnimSeq) {
    if (!AnimSeq.update()) return false;
    SwitchSeq._waitAnimSeq = false;
  }

  if (SwitchSeq._waitingCry) {
    const A: any = Audio;
    if (truthy(A.isCryPlaying) && truthy(A.isCryPlaying())) {
      return false;
    }
    SwitchSeq._waitingCry = false;
    SwitchSeq._waiting = false;
    advance();
  }

  if (SwitchSeq._waitingMsg) {
    // package.loaded["src.core.game3.battle.ui"]
    const pending = truthy(Ui) && ((truthy(Ui.dialogPending) && truthy(Ui.dialogPending()))
      || (truthy(Ui.busy) && truthy(Ui.busy())));
    if (pending) {
      return false;
    }
    SwitchSeq._waitingMsg = false;
    SwitchSeq._waiting = false;
    advance();
  }

  if (SwitchSeq._waiting) {
    if (Anim.busy()) {
      return false;
    }
    SwitchSeq._waiting = false;
  }

  while (truthy(SwitchSeq._steps) && SwitchSeq._i <= len(SwitchSeq._steps)) {
    run_step(SwitchSeq._steps![SwitchSeq._i]);
    if (SwitchSeq._waiting || SwitchSeq._waitingCry || SwitchSeq._waitingMsg || SwitchSeq._waitAnimSeq
        || truthy(SwitchSeq._waitingMonAnim)) {
      return false;
    }
  }

  finish();
  return true;
};

export default SwitchSeq;
