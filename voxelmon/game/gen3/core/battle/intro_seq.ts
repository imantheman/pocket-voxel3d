// Port of gen1recomp src/core/game3/battle/intro_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle intro presentation (pret BeginBattleIntro + DoPokeballSendOutAnimation).
// Separate from AnimSeq (hit loop); same contract as ExpSeq.
//
// Port notes:
// - package.loaded battle / message and the lazy requires (battle_chrome,
//   trainers, link.battle, fade, ui, pokedude, anim_ctx) are static imports.
// - Multiple returns are tuples: center_of -> [x, y];
//   Pokedude.sendOutOrigin -> [x, y].
// - pcall'd SE / cry calls are try/catch.
// - multiTrainerPics reads link.battle's trainer pic ids behind Brian's own
//   `st.multi and st.linkGenders` guard (link battles are deferred; an
//   offline battle never reaches it).
// - build_wild's `add("cry", ...) add("undarken", ...)` share one Lua line;
//   both are kept in order.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import Anim from "./anim.ts";
import BallOpen from "./ball_open.ts";
import State from "./state.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
import RomText from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import Adapter from "./adapter.ts";
import ShinySeq from "./shiny_seq.ts";
import MonAnimBattle from "./mon_anim_battle.ts";
import BattleChrome from "../../ui/battle_chrome.ts";
import Trainers from "../scripting/trainers.ts";
import LinkBattle from "../link/battle.ts";
import Fade from "../../ui/fade.ts";
import Message from "../../ui/message.ts";
import Pokedude from "./pokedude.ts";
import AnimCtx from "./anim_ctx.ts";
import Ui from "./ui.ts";
import { Battle } from "../battle.ts";

type Fn = (...a: any[]) => any;

export interface IntroSeqModule {
  _steps: LuaTable | null | undefined;
  _i: number;
  _waiting: boolean;
  _pushMsg: Fn | null | undefined;
  _headless: boolean;
  _opts: any;
  _st: any;
  _waitingMsg?: boolean;
  _waitingFade?: boolean;
  _waitingCry?: boolean;
  _waitingGen?: boolean;
  _pendingSlideIn?: (() => void) | null;
  _cryQueue?: any;
  _waitingMonAnim?: LuaTable | null;
  reset(): void;
  busy(): boolean;
  releaseCryMode(mon: any): number;
  introText(st: any): string;
  headlessGhostIntro(st: any): LuaTable;
  sendOutText(st: any, side: string): string;
  multiTrainerPics(st: any, playerGender?: any): any;
  begin(st: any, opts?: any): boolean;
  update(): boolean;
}

export const IntroSeq = {} as IntroSeqModule;

IntroSeq._steps = undefined;
IntroSeq._i = 1;
IntroSeq._waiting = false;
IntroSeq._pushMsg = undefined;
IntroSeq._headless = false;
IntroSeq._opts = undefined;
IntroSeq._st = undefined;

// Lua: intro_seq.lua:25
IntroSeq.reset = function (): void {
  IntroSeq._steps = undefined;
  IntroSeq._i = 1;
  IntroSeq._waiting = false;
  IntroSeq._waitingMsg = false;
  IntroSeq._waitingFade = false;
  IntroSeq._waitingCry = false;
  IntroSeq._waitingGen = false;
  IntroSeq._pendingSlideIn = undefined;
  IntroSeq._pushMsg = undefined;
  IntroSeq._opts = undefined;
  IntroSeq._st = undefined;
  IntroSeq._cryQueue = undefined;
  IntroSeq._waitingMonAnim = undefined;
};

// Lua: intro_seq.lua:41
IntroSeq.busy = function (): boolean {
  return IntroSeq._steps != null;
};

// Lua: intro_seq.lua:45
function finish(): void {
  IntroSeq._steps = undefined;
  IntroSeq._i = 1;
  IntroSeq._waiting = false;
  IntroSeq._waitingMsg = false;
  IntroSeq._waitingFade = false;
  IntroSeq._waitingCry = false;
  IntroSeq._pendingSlideIn = undefined;
}

// Lua: intro_seq.lua:55
function advance(): void {
  IntroSeq._waiting = false;
  IntroSeq._i = IntroSeq._i + 1;
}

// Lua: intro_seq.lua:60
function stage(): any {
  return Anim.stage();
}

// Lua: intro_seq.lua:64
function present_of(key: any): any {
  if (typeof key !== "number") return Anim.present(key);
  const p = Anim.present(key);
  if (truthy(p)) return p;
  if (key < 2) { const q = Anim.present(State.sideOf(key)); if (truthy(q)) return q; }
  return undefined;
}

// Lua: intro_seq.lua:69
function healthbox_of(s: any, key: any): any {
  const hb = truthy(s) ? s.healthbox : undefined;
  if (!truthy(hb)) return undefined;
  if (typeof key !== "number") return hb[key];
  if (truthy(hb[key])) return hb[key];
  if (key < 2 && truthy(hb[State.sideOf(key)])) return hb[State.sideOf(key)];
  return undefined;
}

// Lua: intro_seq.lua:76
function center_of(st: any, key: any): [number, number] {
  if (typeof key === "number" && truthy(Anim.coords)) {
    const a = Anim.coords(st, key);
    if (a !== null && typeof a === "object") return [a.x ?? a[1], a.y ?? a[2]];
    if (truthy(a)) return [a, undefined as any];
  }
  const side = (typeof key === "number") ? State.sideOf(key) : key;
  const base = (side === "player") ? Anim.PLAYER_MON : Anim.ENEMY_MON;
  return [base.x, base.y];
}

// Lua: intro_seq.lua:87
function battler_of(st: any, key: any): any {
  if (!truthy(st)) return undefined;
  if (typeof key === "number") return State.battler(st, key);
  return st[key];
}

// Lua: intro_seq.lua:93
function ball_for(s: any, key: any, st: any): any {
  let b: any;
  if (typeof key !== "number") {
    b = s.ball;
  } else {
    s.balls = s.balls ?? {};
    b = s.balls[key];
    if (!truthy(b)) {
      b = { visible: false, x: 0, y: 0, frame: 0, rot: 0, battler: key, side: State.sideOf(key) };
      s.balls[key] = b;
    }
  }
  let mon = battler_of(st, key);
  mon = truthy(mon) ? mon.mon : mon;
  // pokefirered/src/pokeball.c:373
  b.ballId = BallOpen.ballIdForItem(truthy(mon) ? mon.pokeball : undefined);
  return b;
}

// Lua: intro_seq.lua:112
function present_ids(st: any, ids: LuaTable | null | undefined): LuaTable {
  const out: LuaTable = [null];
  for (const [, id] of ipairs<number>(ids ?? [null])) {
    if (truthy(st) && !State.isAbsent(st, id) && truthy(State.battler(st, id))) out[len(out) + 1] = id;
  }
  return out;
}

// Lua: intro_seq.lua:120
function ball_status(mon: any): string {
  if (!truthy(mon)) return "empty";
  const hp = tonumber(mon.hp) ?? 0;
  if (hp <= 0) return "faint";
  const status = mon.status;
  if (truthy(status) && status !== 0 && status !== "") return "status";
  return "ok";
}

// Lua: intro_seq.lua:129
function player_party_balls(party: any): LuaTable {
  const balls: LuaTable = [null];
  const count = len(party ?? [null]);
  for (let i = 1; i <= 6; i++) {
    if (i <= count && truthy(party[i])) {
      balls[i] = ball_status(party[i]);
    } else {
      balls[i] = "empty";
    }
  }
  return balls;
}

// Lua: intro_seq.lua:142
function enemy_party_balls(foeParty: any, partySize: any): LuaTable {
  const balls: LuaTable = [null];
  const count = Math.max(1, Math.min(6, tonumber(partySize) ?? (truthy(foeParty) ? len(foeParty) : undefined) ?? 1));
  let s = 6;
  for (let i = 1; i <= 6; i++) {
    if (i <= count) {
      const mon = truthy(foeParty) ? foeParty[i] : undefined;
      balls[s] = truthy(mon) ? ball_status(mon) : "ok";
    } else {
      balls[s] = "empty";
    }
    s = s - 1;
  }
  return balls;
}

// pokefirered/src/battle_gfx_sfx_util.c:1045
// Lua: intro_seq.lua:159
function release_cry_mode(mon: any): number {
  if (!truthy(mon)) return 0;
  const status = mon.status;
  if (truthy(status) && status !== 0 && status !== "") return 11;
  // pcall(require, "src.ui.game3.battle_chrome")
  if (truthy(BattleChrome) && truthy(BattleChrome.hpBarLevel)) {
    const lvl = BattleChrome.hpBarLevel(mon.hp, mon.maxHp);
    if (lvl !== "green" && lvl !== "full") return 11;
  }
  return 0;
}
IntroSeq.releaseCryMode = release_cry_mode;

// Lua: intro_seq.lua:172
IntroSeq.introText = function (st: any): string {
  return BattleText.get(BattleText.INTROMSG, Adapter.fill(st, {
    opponentMon1: st.enemy,
    opponentMon2: truthy(st.double) ? State.battler(st, 3) : undefined,
  }));
};

// Lua: intro_seq.lua:177
function intro_msg(st: any): string {
  return IntroSeq.introText(st);
}

// pokefirered/src/battle_setup.c:320
// Lua: intro_seq.lua:180
function unveil_ghost(st: any): void {
  const p = Anim.present("enemy");
  if (truthy(p)) p.ghostUnveiled = true;
  if (truthy(st) && truthy(st.enemy) && truthy(st.enemy.mon) && st.enemy.mon.nickname === RomText.plain("gText_Ghost")) {
    st.enemy.mon.nickname = undefined;
  }
}

// pokefirered/src/battle_message.c:1574
// Lua: intro_seq.lua:189
IntroSeq.headlessGhostIntro = function (st: any): LuaTable {
  if (!(truthy(st) && truthy(st.ghostBattle))) return [null];
  if (!truthy(st.ghostUnveiled)) return seq(intro_msg(st));
  unveil_ghost(st);
  return seq(intro_msg(st), BattleText.get("STRINGID_SILPHSCOPEUNVEILED"), BattleText.get("STRINGID_GHOSTWASMAROWAK"));
};

/** `(st.oldManTutorial and 5) or (st.backPicOverride) or opts.playerGender or 0` */
function player_gender(st: any, opts: any): any {
  if (truthy(st.oldManTutorial)) return 5;
  if (truthy(st.backPicOverride)) return st.backPicOverride;
  if (truthy(opts.playerGender)) return opts.playerGender;
  return 0;
}

// Lua: intro_seq.lua:196
function build_wild(st: any, opts: any): LuaTable {
  const steps: LuaTable = [null];
  const add = (kind: string, data?: any): void => {
    steps[len(steps) + 1] = { kind, data: data ?? {} };
  };
  const playerGender = player_gender(st, opts);
  add("fade", { mode: "FROM_BLACK", instant: true });
  // pret: player back sprite slides in with the BG intro even in wild battles
  // (BattleIntroDrawTrainersOrMonsSprites → EmitDrawTrainerPic for PLAYER_LEFT).
  // pokefirered/src/battle_intro.c:145
  add("bgslide", {
    frames: 154,
    unlockAt: 35,
    slidePlayer: true,
    slideEnemyMon: true,
    playerFrom: 240,
    playerTo: 0,
    enemyMonFrom: -240,
    enemyMonTo: 0,
    slideFrames: 120,
    darken: 10 / 16,
    gender: playerGender,
  });
  add("shiny_check", { side: "enemy" });
  add("cry", { side: "enemy" }); add("undarken", { side: "enemy", frames: 10 });
  add("healthbox", { side: "enemy", frames: 23, from: -115 });
  // pokefirered/src/battle_message.c:1551
  add("msg", { text: intro_msg(st) });
  if (truthy(st.ghostBattle) && truthy(st.ghostUnveiled)) {
    // pokefirered/data/battle_scripts_1.s:3820
    add("wait", { frames: 32 });
    add("msg", { text: BattleText.get("STRINGID_SILPHSCOPEUNVEILED"), linger: true });
    add("general", { name: "SILPH_SCOPED", side: "enemy" });
    add("unveil", {});
    add("wait", { frames: 32 });
    add("msg", { text: BattleText.get("STRINGID_GHOSTWASMAROWAK") });
  }
  if (truthy(st.safari)) {
    // pokefirered/src/battle_controller_safari.c:608
    add("healthbox", { side: "player", frames: 23, from: 115 });
    add("wait", { frames: 3 });
    return steps;
  }
  if (truthy(st.oldManTutorial)) {
    // pokefirered/src/battle_controller_oak_old_man.c
    // In Oak/Old Man tutorial, the player's Pokémon is not sent out and there is no player healthbox.
    // The Old Man backsprite stays at (0, 0) and the battle transitions straight to action selection.
    add("wait", { frames: 3 });
    return steps;
  }
  // pokefirered/src/battle_message.c:1592
  add("msg", { text: IntroSeq.sendOutText(st, "player"), linger: true });
  add("player_throw", {});
  add("shiny_check", { side: "player" });
  add("healthbox", { side: "player", frames: 23, from: 115 });
  add("wait", { frames: 3 });
  return steps;
}

// Lua: intro_seq.lua:255
IntroSeq.sendOutText = function (st: any, side: string): string {
  const double = truthy(st.double) ? true : false;
  const fill: any = { side, double };
  if (side === "player") {
    fill.playerMon1 = State.battler(st, 0);
    fill.playerMon2 = double ? State.battler(st, 2) : undefined;
    if (double && State.isAbsent(st, 2)) fill.double = false;
  } else {
    fill.opponentMon1 = State.battler(st, 1);
    fill.opponentMon2 = double ? State.battler(st, 3) : undefined;
    if (double && State.isAbsent(st, 3)) fill.double = false;
  }
  return BattleText.get(BattleText.INTROSENDOUT, Adapter.fill(st, fill));
};

// Lua: intro_seq.lua:270
function build_trainer(st: any, opts: any): LuaTable {
  const steps: LuaTable = [null];
  const add = (kind: string, data?: any): void => {
    steps[len(steps) + 1] = { kind, data: data ?? {} };
  };
  const strings: any = Trainers.introStrings(
    truthy(opts.trainerId) ? opts.trainerId : st.trainerId,
    State.displayName(st.enemy),
    { rivalName: opts.rivalName });
  const info = strings.info ?? {};
  const enemyBalls = enemy_party_balls(st.foeParty,
    (truthy(info.partySize) ? info.partySize : undefined) ?? (truthy(st.foeParty) ? len(st.foeParty) : undefined) ?? 1);
  if (truthy(st.trainerB) && truthy(st.foeHalf)) {
    // pokeemerald/src/battle_interface.c:1597
    const slots: any[] = [null];
    for (let i = 1; i <= 3; i++) slots[i] = (i <= st.foeHalf) ? st.foeParty[i] : false;
    for (let i = 1; i <= 3; i++) slots[3 + i] = st.foeParty[st.foeHalf + i] ?? false;
    for (let i = 1; i <= 6; i++) enemyBalls[7 - i] = truthy(slots[i]) ? ball_status(slots[i]) : "empty";
    strings.wants = IntroSeq.introText(st);
  }
  const playerBalls = player_party_balls(truthy(st.playerParty) ? st.playerParty : (truthy(st.player) ? seq(st.player.mon) : st.player));

  add("fade", { mode: "FROM_BLACK", instant: true });
  // pret: DrawTrainerPic for both sides during BG slide; sprites wait off-screen
  // until gIntroSlideFlags clears, then SpriteCB_TrainerSlideIn (~120f at 2px/frame).
  // pokefirered/src/battle_intro.c:145
  add("bgslide", {
    frames: 154,
    unlockAt: 35,
    slidePlayer: true,
    slideEnemy: true,
    playerFrom: 240,
    playerTo: 0,
    enemyFrom: -240,
    enemyTo: 0,
    slideFrames: 120,
    picId: truthy(opts.trainerPicId) ? opts.trainerPicId : info.pic,
    gender: truthy(opts.playerGender) ? opts.playerGender : 0,
  });
  add("partybar", {
    enemyBalls,
    playerBalls,
    frames: 20,
  });
  if (truthy(st.double)) {
    const foeIds = present_ids(st, seq(1, 3));
    const plIds = present_ids(st, seq(0, 2));
    let sentOut = strings.sentOut;
    if (len(foeIds) === 2) {
      // pokefirered/src/battle_message.c:1611
      sentOut = IntroSeq.sendOutText(st, "enemy");
    }
    const goText = IntroSeq.sendOutText(st, "player");
    add("msg", { text: strings.wants });
    add("msg", { text: sentOut });
    add("opponent_sendout", { toX: 280, frames: 35, ids: foeIds });
    add("shiny_check", { ids: foeIds });
    add("cry", { side: "enemy", release: true, ids: foeIds });
    add("healthbox", { side: "enemy", frames: 23, from: -115, ids: foeIds });
    add("msg", { text: goText, linger: true });
    add("player_throw", { ids: plIds });
    add("shiny_check", { ids: plIds });
    add("healthbox", { side: "player", frames: 23, from: 115, ids: plIds });
    add("wait", { frames: 3 });
    return steps;
  }
  add("msg", { text: strings.wants });
  add("msg", { text: strings.sentOut });
  add("opponent_sendout", { toX: 280, frames: 35 });
  add("shiny_check", { side: "enemy" });
  add("cry", { side: "enemy", release: true });
  add("healthbox", { side: "enemy", frames: 23, from: -115 });
  add("msg", { text: IntroSeq.sendOutText(st, "player"), linger: true });
  add("player_throw", {});
  add("shiny_check", { side: "player" });
  add("healthbox", { side: "player", frames: 23, from: 115 });
  add("wait", { frames: 3 });
  return steps;
}

// Lua: intro_seq.lua:350
IntroSeq.multiTrainerPics = function (st: any, playerGender?: any): any {
  if (!(truthy(st) && truthy(st.multi) && truthy(st.linkGenders))) return undefined;
  const LB: any = LinkBattle;
  const own = tonumber(st.linkOwn) ?? 0;
  const g = st.linkGenders;
  const front = (gender: any): any => (gender === 1) ? LB.TRAINER_PIC_LEAF : LB.TRAINER_PIC_RED;
  const towerA = truthy(st.towerLinkMulti) ? st.trainerPicId : undefined;
  const towerB = truthy(st.towerLinkMulti) && truthy(st.trainerB) ? st.trainerB.pic : undefined;
  return {
    // pokefirered/src/battle_controller_link_opponent.c:1133
    // pokeemerald/src/battle_controller_link_opponent.c:1228
    enemyPic: truthy(towerA) ? towerA : front(g[1]), enemyX: 200,
    enemyPic2: truthy(towerB) ? towerB : front(g[3]), enemyX2: 152,
    // pokefirered/src/battle_controller_player.c:2171
    gender: g[own] ?? (truthy(playerGender) ? playerGender : undefined) ?? 0, x: (own === 2) ? 90 : 32,
    // pokefirered/src/battle_controller_link_partner.c:1106
    partnerGender: g[(own + 2) % 4] ?? 0, partnerX: (own === 2) ? 32 : 90,
  };
};

/** Begin intro. Returns false when headless (caller pushes strings). */
// Lua: intro_seq.lua:371
IntroSeq.begin = function (st: any, opts?: any): boolean {
  opts = opts ?? {};
  IntroSeq.reset();
  IntroSeq._opts = opts;
  IntroSeq._st = st;
  IntroSeq._pushMsg = opts.pushMsg;
  IntroSeq._headless = truthy(opts.headless) ? true : false;
  if (IntroSeq._headless || !truthy(st)) {
    return false;
  }

  const s = stage();
  s.slide = 0;
  s.slideDone = false;
  s.trainer.player.visible = false;
  s.trainer.enemy.visible = false;
  s.ball.visible = false;
  s.healthbox.player.visible = false;
  s.healthbox.enemy.visible = false;
  s.partyBar.player.visible = false;
  s.partyBar.enemy.visible = false;
  Anim.present("player").visible = false;
  Anim.present("enemy").visible = false;
  Anim.present("player").ox = 0;
  Anim.present("enemy").ox = 0;
  Anim.present("player").darken = 0;
  Anim.present("enemy").darken = 0;
  Anim.present("player").scale = 1;
  Anim.present("enemy").scale = 1;
  if (truthy(st.double)) {
    s.balls = {};
    for (let id = 0; id <= 3; id++) {
      const p = present_of(id);
      if (truthy(p)) { p.visible = false; p.ox = 0; p.darken = 0; p.scale = 1; }
      const hb = healthbox_of(s, id);
      if (truthy(hb)) hb.visible = false;
    }
  }

  const playerGender = player_gender(st, opts);
  s.bgSlide = { enemyOx: -240, playerOx: 240 };
  s.trainer.player.visible = true;
  s.trainer.player.gender = playerGender;
  s.trainer.player.ox = 240;
  s.trainer.player.frame = 0;

  if (truthy(st.wild)) {
    const p = Anim.present("enemy");
    p.visible = true;
    p.ox = -240;
    p.darken = 10 / 16;
    IntroSeq._steps = build_wild(st, opts);
  } else {
    s.trainer.enemy.visible = true;
    s.trainer.enemy.picId = truthy(opts.trainerPicId) ? opts.trainerPicId : st.trainerPicId;
    s.trainer.enemy.ox = -240;
    s.trainer.enemy.x = undefined; s.trainer.enemy.pic2 = undefined; s.trainer.enemy.x2 = undefined;
    s.trainer.player.x = undefined; s.trainer.player.gender2 = undefined; s.trainer.player.x2 = undefined;
    const pics = IntroSeq.multiTrainerPics(st, playerGender);
    if (truthy(st.trainerB)) {
      // pokeemerald/src/battle_controller_opponent.c:1296
      s.trainer.enemy.x = 200;
      s.trainer.enemy.pic2 = st.trainerB.pic; s.trainer.enemy.x2 = 152;
    }
    if (truthy(pics)) {
      s.trainer.enemy.picId = pics.enemyPic; s.trainer.enemy.x = pics.enemyX;
      s.trainer.enemy.pic2 = pics.enemyPic2; s.trainer.enemy.x2 = pics.enemyX2;
      s.trainer.player.gender = pics.gender; s.trainer.player.x = pics.x;
      s.trainer.player.gender2 = pics.partnerGender; s.trainer.player.x2 = pics.partnerX;
    }
    if (truthy(st.partner) && truthy(st.partner.backPic)) {
      // pokeemerald/src/battle_controller_player_partner.c:1304
      s.trainer.player.x = 32;
      s.trainer.player.gender2 = st.partner.backPic; s.trainer.player.x2 = 90;
    }
    IntroSeq._steps = build_trainer(st, opts);
  }
  IntroSeq._steps = MonAnimBattle.introSteps(IntroSeq._steps!, st.wild);
  IntroSeq._i = 1;
  return true;
};

// Lua: intro_seq.lua:453
function wait_busy(): void {
  IntroSeq._waiting = true;
}

/** `Battle and Battle._st` (package.loaded["src.core.game3.battle"]). */
function battle_st(): any {
  return truthy(Battle) ? Battle._st : undefined;
}

// Lua: intro_seq.lua:457
function run_step(step: any): void {
  const kind = step.kind;
  const d = step.data ?? {};
  const s = stage();

  if (kind === "mon_anim") {
    for (const [, key] of ipairs(d.ids ?? [null])) {
      MonAnimBattle.start(key, d.kind, { st: IntroSeq._st, noCry: d.noCry });
    }
    advance();
    return;
  }

  if (kind === "mon_anim_wait") {
    IntroSeq._waitingMonAnim = d.ids;
    return;
  }

  if (kind === "shiny_check") {
    const st = truthy(IntroSeq._st) ? IntroSeq._st : battle_st();
    const keys: LuaTable = truthy(d.ids) ? d.ids : seq(d.id != null ? d.id : (truthy(d.side) ? d.side : "enemy"));
    const battlers: LuaTable = [null];
    for (const [, key] of ipairs(keys)) {
      battlers[len(battlers) + 1] = battler_of(st, key);
    }
    if (ShinySeq.startMany(battlers, keys)) {
      // FireRed starts shiny sparkle tasks before the healthbox animation and
      // waits for both to drain. Advancing here lets the next healthbox step
      // schedule its tween while the shared animation VM remains busy.
      advance();
      return;
    }
    advance();
    return;
  }

  if (kind === "fade") {
    // pcall(require, "src.ui.game3.fade")
    const F: any = Fade;
    // pokefirered/src/battle_main.c:648
    if (truthy(d.instant)) {
      if (truthy(F) && truthy(F.clear)) F.clear();
      advance();
      return;
    }
    if (truthy(F) && truthy(F.begin)) {
      const mode = (truthy(F.MODE) ? F.MODE[truthy(d.mode) ? d.mode : "FROM_BLACK"] : undefined) || 0;
      IntroSeq._waiting = true;
      IntroSeq._waitingFade = true;
      F.begin(mode, truthy(d.speed) ? d.speed : 1, () => {
        IntroSeq._waitingFade = false;
        IntroSeq._waiting = false;
        advance();
      });
    } else {
      advance();
    }
    return;
  }

  if (kind === "bgslide") {
    const frames = d.frames ?? 154;
    const unlockAt = d.unlockAt ?? 35;
    const slideFrames = d.slideFrames ?? 120;
    const needSpriteSlide = truthy(d.slidePlayer) || truthy(d.slideEnemy) || truthy(d.slideEnemyMon);
    s.bgSlide = s.bgSlide ?? { enemyOx: 0, playerOx: 0 };
    // pret DrawTrainersOrMonsSprites: park sprites off-screen immediately;
    // SpriteCB_TrainerSlideIn starts once gIntroSlideFlags clears (unlockAt).
    if (truthy(d.slidePlayer)) {
      s.trainer.player.visible = true;
      s.trainer.player.gender = truthy(d.gender) ? d.gender : 0;
      s.trainer.player.ox = d.playerFrom ?? 240;
      s.trainer.player.frame = 0;
      s.bgSlide.playerOx = d.playerFrom ?? 240;
    }
    if (truthy(d.slideEnemy)) {
      s.trainer.enemy.visible = true;
      s.trainer.enemy.picId = d.picId;
      s.trainer.enemy.ox = d.enemyFrom ?? -240;
      s.bgSlide.enemyOx = d.enemyFrom ?? -240;
    }
    if (truthy(d.slideEnemyMon)) {
      const p = Anim.present("enemy");
      p.visible = true;
      p.ox = d.enemyMonFrom ?? d.from ?? -240;
      p.darken = d.darken ?? (10 / 16);
      s.bgSlide.enemyOx = d.enemyMonFrom ?? d.from ?? -240;
    }
    wait_busy();
    let spritesStarted = false;
    let spritesDone = !needSpriteSlide;
    let bgDone = false;
    const try_advance = (): void => {
      if (bgDone && spritesDone) {
        s.bgSlide.enemyOx = 0;
        s.bgSlide.playerOx = 0;
        advance();
      }
    };
    const start_sprite_slide = (): void => {
      if (spritesStarted || !needSpriteSlide) return;
      spritesStarted = true;
      const pFrom = d.playerFrom ?? 240;
      const pTo = d.playerTo ?? 0;
      const eFrom = d.enemyFrom ?? -240;
      const eTo = d.enemyTo ?? 0;
      const mFrom = d.enemyMonFrom ?? d.from ?? -240;
      const mTo = d.enemyMonTo ?? d.to ?? 0;
      Anim.tweenStage(slideFrames, (u: number) => {
        if (truthy(d.slidePlayer)) {
          s.trainer.player.ox = pFrom + (pTo - pFrom) * u;
          s.bgSlide.playerOx = pFrom + (pTo - pFrom) * u;
        }
        if (truthy(d.slideEnemy)) {
          s.trainer.enemy.ox = eFrom + (eTo - eFrom) * u;
          s.bgSlide.enemyOx = eFrom + (eTo - eFrom) * u;
        }
        if (truthy(d.slideEnemyMon)) {
          const p = Anim.present("enemy");
          p.ox = mFrom + (mTo - mFrom) * u;
          s.bgSlide.enemyOx = mFrom + (mTo - mFrom) * u;
        }
      }, () => {
        if (truthy(d.slidePlayer)) {
          s.trainer.player.ox = pTo;
          s.bgSlide.playerOx = pTo;
        }
        if (truthy(d.slideEnemy)) {
          s.trainer.enemy.ox = eTo;
          s.bgSlide.enemyOx = eTo;
        }
        if (truthy(d.slideEnemyMon)) {
          Anim.present("enemy").ox = mTo;
          s.bgSlide.enemyOx = mTo;
        }
        spritesDone = true;
        try_advance();
      });
    };
    Anim.tweenStage(frames, (u: number) => {
      s.slide = u;
      if (u * frames >= unlockAt) {
        s.slideDone = true;
        start_sprite_slide();
      }
    }, () => {
      s.slide = 1;
      s.slideDone = true;
      start_sprite_slide();
      bgDone = true;
      try_advance();
    });
    return;
  }

  if (kind === "slidein") {
    if (d.who === "enemy_mon") {
      const p = Anim.present("enemy");
      p.visible = true;
      p.ox = d.from ?? -240;
      p.darken = d.darken ?? (10 / 16);
      wait_busy();
      const start_move = (): void => {
        Anim.tweenStage(d.frames ?? 120, (u: number) => {
          p.ox = (d.from ?? -240) + ((d.to ?? 0) - (d.from ?? -240)) * u;
        }, () => {
          p.ox = d.to ?? 0;
          advance();
        });
      };
      if (truthy(s.slideDone)) {
        start_move();
      } else {
        // Wait until intro slide releases sprites.
        IntroSeq._pendingSlideIn = start_move;
        wait_busy();
      }
      return;
    }
    if (d.who === "both_trainers") {
      s.trainer.enemy.visible = true;
      s.trainer.enemy.picId = d.picId;
      s.trainer.enemy.ox = d.enemyFrom ?? -240;
      s.trainer.player.visible = true;
      s.trainer.player.gender = truthy(d.gender) ? d.gender : 0;
      s.trainer.player.ox = d.playerFrom ?? 240;
      s.trainer.player.frame = 0;
      wait_busy();
      const start_move = (): void => {
        Anim.tweenStage(d.frames ?? 120, (u: number) => {
          s.trainer.enemy.ox = (d.enemyFrom ?? -240)
            + ((d.enemyTo ?? 0) - (d.enemyFrom ?? -240)) * u;
          s.trainer.player.ox = (d.playerFrom ?? 240)
            + ((d.playerTo ?? 0) - (d.playerFrom ?? 240)) * u;
        }, () => {
          s.trainer.enemy.ox = d.enemyTo ?? 0;
          s.trainer.player.ox = d.playerTo ?? 0;
          advance();
        });
      };
      if (truthy(s.slideDone)) {
        start_move();
      } else {
        IntroSeq._pendingSlideIn = start_move;
        wait_busy();
      }
      return;
    }
  }

  if (kind === "undarken") {
    const p = Anim.present(truthy(d.side) ? d.side : "enemy");
    const from = p.darken ?? 0;
    wait_busy();
    Anim.tweenStage(d.frames ?? 10, (u: number) => {
      p.darken = from * (1 - u);
    }, () => {
      p.darken = 0;
      advance();
    });
    return;
  }

  if (kind === "partybar") {
    s.partyBar.enemy.visible = true;
    s.partyBar.enemy.ox = -100;
    s.partyBar.enemy.balls = d.enemyBalls ?? seq("ok");
    s.partyBar.player.visible = true;
    s.partyBar.player.ox = 100;
    s.partyBar.player.balls = d.playerBalls ?? seq("ok");
    wait_busy();
    Anim.tweenStage(d.frames ?? 20, (u: number) => {
      s.partyBar.enemy.ox = -100 + 100 * u;
      s.partyBar.player.ox = 100 - 100 * u;
    }, () => {
      s.partyBar.enemy.ox = 0;
      s.partyBar.player.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "msg") {
    if (truthy(d.linger) && truthy(d.text)) {
      Ui.pushTimed(d.text, 0);
    } else if (truthy(IntroSeq._pushMsg) && truthy(d.text)) {
      IntroSeq._pushMsg!(d.text);
    }
    // pret waits for PrintString / controller exec before send-out / slide-out.
    // Do not advance past this step until Ui has shown + dismissed the line.
    IntroSeq._waiting = true;
    IntroSeq._waitingMsg = true;
    return;
  }

  if (kind === "trainerexit") {
    const side = truthy(d.side) ? d.side : "enemy";
    const tr = s.trainer[side];
    const from = tr.ox ?? 0;
    let to: number;
    // Store as ox delta from resting center: resting ox=0 at center.
    // Enemy exit: center 176 → 280 ⇒ ox 0 → 104
    if (side === "enemy") {
      to = (d.toX ?? 280) - 176;
    } else {
      to = (d.toX ?? -40) - 80;
    }
    s.partyBar[side].visible = false;
    wait_busy();
    Anim.tweenStage(d.frames ?? 35, (u: number) => {
      tr.ox = from + (to - from) * u;
    }, () => {
      tr.ox = to;
      tr.visible = false;
      advance();
    });
    return;
  }

  if (kind === "opponent_sendout") {
    const st = battle_st();
    const keys: LuaTable = truthy(d.ids) ? d.ids : seq("enemy");
    const mons: LuaTable = [null];
    for (const [n, key] of ipairs(keys)) {
      const [cx, cy] = center_of(st, key);
      const ball = ball_for(s, key, st);
      ball.visible = true;
      ball.frame = 0;
      ball.rot = 0;
      ball.side = "enemy";
      ball.x = cx;
      ball.y = cy + 24;
      mons[n] = { key, ball };
    }
    const tr = s.trainer.enemy;
    const exitFrom = tr.ox ?? 0;
    const exitTo = (d.toX ?? 280) - 176;
    s.partyBar.enemy.visible = false;
    wait_busy();
    // pret OpponentHandleIntroTrainerBallThrow: starts linear slide-out (35 frames)
    // AND StartSendOutAnim (16f delay + 12f emergence).
    const totalFrames = d.frames ?? 35;
    let openedSe = false;
    Anim.tweenStage(totalFrames, (_u: number, t: any) => {
      const f = t.frames;
      // Opponent trainer slides offscreen (35 frames)
      tr.ox = exitFrom + (exitTo - exitFrom) * Math.min(1, f / totalFrames);
      if (f >= totalFrames) {
        tr.visible = false;
      }
      for (const [, m] of ipairs<any>(mons)) {
        const ball = m.ball;
        // Ball opens after 16 frames delay (SpriteCB_OpponentMonSendOut)
        if (f === 16) {
          ball.frame = 1;
          if (!openedSe) {
            openedSe = true;
            try { Audio.playSe(SE.SE_BALL_OPEN, { pan: 63 }); } catch { /* pcall */ }
          }
          const p = present_of(m.key);
          if (truthy(p)) {
            p.visible = true;
            p.ox = 0;
            p.oy = 16;
            p.scale = 0.16;
            p.darken = 0;
          }
          Anim.ballOpen(m.key, ball.x, ball.y);
        }
        // Emergence over 12 frames (frames 16..28) matching pret BATTLER_AFFINE_EMERGE
        if (f > 16 && f <= 28) {
          const eu = (f - 16) / 12;
          const p = present_of(m.key);
          if (truthy(p)) {
            p.oy = 16 * (1 - eu);
            p.scale = 0.16 + 0.84 * eu;
          }
          ball.frame = (eu < 0.5) ? 1 : 2;
        }
        if (f > 28) {
          const p = present_of(m.key);
          if (truthy(p)) {
            p.oy = 0;
            p.scale = 1;
          }
          ball.visible = false;
        }
      }
    }, () => {
      tr.visible = false;
      tr.ox = exitTo;
      for (const [, m] of ipairs<any>(mons)) {
        m.ball.visible = false;
        const p = present_of(m.key);
        if (truthy(p)) {
          p.oy = 0;
          p.scale = 1;
        }
      }
      advance();
    });
    return;
  }

  if (kind === "player_throw") {
    const st = battle_st();
    const keys: LuaTable = truthy(d.ids) ? d.ids : seq("player");
    const tr = s.trainer.player;
    if (!truthy(tr.visible)) {
      tr.visible = true;
      tr.ox = 0;
      tr.frame = 0;
      tr.gender = (truthy(IntroSeq._opts) && truthy(IntroSeq._opts.playerGender) ? IntroSeq._opts.playerGender : undefined) ?? 0;
    }
    s.partyBar.player.visible = false;
    // pret sAnimCmd_Red_1: 1(20) 2(6) 3(6) 4(24) 0(1) = 57f; exit linear ox 0→-120 over 50f.
    const pose: LuaTable = seq(seq(1, 20), seq(2, 6), seq(3, 6), seq(4, 24), seq(0, 1));
    let poseFrame = 0, poseLeft = 0, poseI = 0;
    const exitTo = -120;
    const mons: LuaTable = [null];
    for (const [n, key] of ipairs(keys)) {
      const [pcx, pcy] = center_of(st, key);
      mons[n] = { key, ball: ball_for(s, key, st), tx: pcx, ty: pcy + 24 };
    }
    let threwSe = false, openedSe = false;
    wait_busy();
    Anim.tweenStage(57, (_u: number, t: any) => {
      const f = t.frames;
      if (poseLeft <= 0) {
        poseI = poseI + 1;
        const entry = pose[poseI];
        if (truthy(entry)) {
          poseFrame = entry[1];
          poseLeft = entry[2];
        }
      }
      poseLeft = poseLeft - 1;
      tr.frame = poseFrame;
      if (f <= 50) {
        tr.ox = exitTo * (f / 50);
      } else {
        tr.visible = false;
        tr.ox = exitTo;
      }
      for (const [, m] of ipairs<any>(mons)) {
        const ball = m.ball;
        // pret Task_StartSendOutAnim (31f delay) + Task_DoPokeballSendOutAnim (1f delay) -> spawn at frame 32
        if (f === 32) {
          ball.visible = true;
          ball.frame = 0;
          ball.rot = 0;
          ball.side = "player";
          const [ox, oy] = Pokedude.sendOutOrigin(st);
          ball.x = ox;
          ball.y = oy;
          ball._sx = ox; ball._sy = oy;
          ball._tx = m.tx; ball._ty = m.ty;
          if (!threwSe) {
            threwSe = true;
            try { Audio.playSe(SE.SE_BALL_THROW, { pan: -64 }); } catch { /* pcall */ }
          }
        }
        // pret SpriteCB_PlayerMonSendOut_1 / 2: 25 frames arc flight with affine rotation
        if (f > 32 && f <= 57 && truthy(ball.visible)) {
          const bu = (f - 32) / 25;
          const sx = ball._sx, sy = ball._sy;
          const tx = ball._tx, ty = ball._ty;
          ball.x = sx + (tx - sx) * bu;
          ball.y = sy + (ty - sy) * bu + (-30 * 4 * bu * (1 - bu));
          // pret sAffineAnim_BallRotate_4: 25 units per frame (approx 0.613 rad/frame)
          ball.rot = (f - 32) * ((25 / 256) * Math.PI * 2);
        }
      }
    }, () => {
      tr.visible = false;
      tr.ox = exitTo;
      if (!openedSe) {
        openedSe = true;
        try { Audio.playSe(SE.SE_BALL_OPEN, { pan: -64 }); } catch { /* pcall */ }
      }
      for (const [, m] of ipairs<any>(mons)) {
        m.ball.frame = 1;
        m.ball.rot = 0;
        Anim.ballOpen(m.key, m.ball.x, m.ball.y);
        const p = present_of(m.key);
        if (truthy(p)) {
          p.visible = true;
          p.ox = 0;
          p.oy = 16;
          p.scale = 0.16;
        }
      }
      if (!truthy(d.ids)) {
        const b = truthy(st) ? st.player : undefined;
        const species = truthy(b) ? (truthy(b.species) ? b.species
          : (truthy(b.mon) ? (truthy(b.mon.species) ? b.mon.species : b.mon.speciesId) : b.mon)) : b;
        if (truthy(species)) {
          // pokefirered/src/pokeball.c:782
          try { Audio.playCry(species, release_cry_mode(b.mon), -25); } catch { /* pcall */ }
        }
      }
      // pret BATTLER_AFFINE_EMERGE: 12 frames scaling 40/256 to 256/256
      Anim.tweenStage(12, (uu: number) => {
        for (const [, m] of ipairs<any>(mons)) {
          const p = present_of(m.key);
          if (truthy(p)) {
            p.oy = 16 * (1 - uu);
            p.scale = 0.16 + 0.84 * uu;
          }
          m.ball.frame = (uu < 0.5) ? 1 : 2;
        }
      }, () => {
        for (const [, m] of ipairs<any>(mons)) {
          const p = present_of(m.key);
          if (truthy(p)) {
            p.oy = 0;
            p.scale = 1;
          }
          m.ball.visible = false;
          m.ball.rot = 0;
        }
        if (truthy(d.ids) && len(d.ids) > 0) {
          IntroSeq._cryQueue = { side: "player", ids: d.ids };
        }
        advance();
      });
    });
    return;
  }

  if (kind === "general") {
    const side = truthy(d.side) ? d.side : "enemy";
    const st = battle_st();
    const b = truthy(st) ? st[side] : undefined;
    const sp = truthy(b) ? (truthy(b.species) ? b.species : (truthy(b.mon) ? b.mon.species : b.mon)) : b;
    wait_busy();
    IntroSeq._waitingGen = true;
    Anim.launchGeneral(d.name, {
      attackerSide: side,
      targetSide: side,
      isReversed: side === "enemy",
      attackerSpecies: sp,
      targetSpecies: sp,
      animArg: 0,
      ctx: AnimCtx.build(side, side, { animArg: 0 }),
      onEnd: () => {
        if (IntroSeq._waitingGen) {
          IntroSeq._waitingGen = false;
          advance();
        }
      },
    });
    return;
  }

  if (kind === "unveil") {
    unveil_ghost(battle_st());
    advance();
    return;
  }

  if (kind === "cry" && truthy(d.ids)) {
    IntroSeq._cryQueue = { side: truthy(d.side) ? d.side : "enemy", ids: d.ids };
    advance();
    return;
  }

  if (kind === "cry") {
    const side = truthy(d.side) ? d.side : "enemy";
    const st = battle_st();
    const battler = truthy(st) ? st[side] : undefined;
    const species = truthy(battler) ? (truthy(battler.species) ? battler.species
      : (truthy(battler.mon) ? (truthy(battler.mon.species) ? battler.mon.species : battler.mon.speciesId) : battler.mon)) : battler;
    if (truthy(species)) {
      // pokefirered/src/battle_main.c:1899
      const mode = truthy(d.release) ? release_cry_mode(battler.mon) : 0;
      Audio.playCry(species, mode, (side === "player") ? -25 : 25);
    }
    IntroSeq._waiting = true;
    IntroSeq._waitingCry = true;
    return;
  }

  if (kind === "healthbox" && truthy(d.ids)) {
    const from = d.from ?? ((d.side === "player") ? 115 : -115);
    const boxes: LuaTable = [null];
    for (const [, id] of ipairs(d.ids)) {
      const hb = healthbox_of(s, id);
      if (truthy(hb)) {
        hb.visible = true;
        hb.ox = from;
        boxes[len(boxes) + 1] = hb;
      }
    }
    wait_busy();
    Anim.tweenStage(d.frames ?? 23, (u: number) => {
      for (const [, hb] of ipairs<any>(boxes)) hb.ox = from * (1 - u);
    }, () => {
      for (const [, hb] of ipairs<any>(boxes)) hb.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "healthbox") {
    const side = truthy(d.side) ? d.side : "enemy";
    const hb = s.healthbox[side];
    const from = d.from ?? ((side === "player") ? 115 : -115);
    hb.visible = true;
    hb.ox = from;
    wait_busy();
    Anim.tweenStage(d.frames ?? 23, (u: number) => {
      hb.ox = from * (1 - u);
    }, () => {
      hb.ox = 0;
      advance();
    });
    return;
  }

  if (kind === "wait") {
    wait_busy();
    Anim.tweenStage(d.frames ?? 1, () => { /* no-op */ }, () => {
      advance();
    });
    return;
  }

  advance();
}

// pokefirered/src/pokeball.c:680
// Lua: intro_seq.lua:1054
function run_cry_queue(): boolean {
  const q = IntroSeq._cryQueue;
  if (!truthy(q)) return true;
  if (truthy(q.waiting) && truthy(Audio.isCryFinished) && !Audio.isCryFinished()) return false;
  q.i = (q.i ?? 0) + 1;
  const id = q.ids[q.i];
  if (id == null) {
    IntroSeq._cryQueue = undefined;
    return true;
  }
  const bst = battle_st();
  const b = truthy(bst) ? State.battler(bst, id) : undefined;
  const species = truthy(b) ? (truthy(b.species) ? b.species
    : (truthy(b.mon) ? (truthy(b.mon.species) ? b.mon.species : b.mon.speciesId) : b.mon)) : b;
  if (truthy(species)) {
    const weak = release_cry_mode(b.mon) !== 0;
    let mode: number;
    if (len(q.ids) > 1 && q.i === 1) mode = weak ? 12 : 1; else mode = weak ? 11 : 0;
    try { Audio.playCry(species, mode, (State.sideOf(id) === "player") ? -25 : 25); } catch { /* pcall */ }
  }
  q.waiting = true;
  return false;
}

// Lua: intro_seq.lua:1077
IntroSeq.update = function (): boolean {
  if (!truthy(IntroSeq._steps)) return true;
  if (IntroSeq._waitingGen) return false;
  if (truthy(IntroSeq._cryQueue) && !run_cry_queue()) return false;

  if (truthy(IntroSeq._pendingSlideIn) && Anim.introSlideDone()) {
    const fn = IntroSeq._pendingSlideIn!;
    IntroSeq._pendingSlideIn = undefined;
    fn();
  }

  if (IntroSeq._waitingCry) {
    if (!truthy(Audio.isCryFinished) || Audio.isCryFinished()) {
      IntroSeq._waitingCry = false;
      IntroSeq._waiting = false;
      advance();
    } else {
      return false;
    }
  }

  if (truthy(IntroSeq._waitingMonAnim)) {
    if (MonAnimBattle.busy(IntroSeq._waitingMonAnim)) return false;
    IntroSeq._waitingMonAnim = undefined;
    advance();
  }

  // Hold on intro dialog until the battle UI queue is drained (wants / sent out).
  if (IntroSeq._waitingMsg) {
    let pending: any = false;
    if (truthy(Ui.dialogPending)) {
      pending = Ui.dialogPending();
    } else if (!truthy(Ui._headless)) {
      // package.loaded["src.ui.game3.message"]
      pending = (Ui._showing === true)
        || (truthy(Ui._queue) && len(Ui._queue) > 0)
        || (truthy(Message) && truthy(Message.isOpen) && truthy(Message.isOpen()));
    }
    if (truthy(pending)) {
      return false;
    }
    IntroSeq._waitingMsg = false;
    IntroSeq._waiting = false;
    advance();
  }

  if (IntroSeq._waiting) {
    if (Anim.busy() || IntroSeq._waitingFade || truthy(IntroSeq._pendingSlideIn)) {
      return false;
    }
    IntroSeq._waiting = false;
  }

  while (truthy(IntroSeq._steps) && IntroSeq._i <= len(IntroSeq._steps)) {
    run_step(IntroSeq._steps![IntroSeq._i]);
    if (IntroSeq._waiting || IntroSeq._waitingFade || IntroSeq._waitingCry
        || IntroSeq._waitingMsg || truthy(IntroSeq._pendingSlideIn) || truthy(IntroSeq._cryQueue)
        || truthy(IntroSeq._waitingMonAnim)) {
      return false;
    }
  }

  finish();
  return true;
};

export default IntroSeq;
