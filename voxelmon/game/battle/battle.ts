// The wild-battle state machine. Ports gen1recomp src/battle/BattleState.lua
// for the v1 wild slice (docs/VOXEL.md §10): the message/action QUEUE is the
// engine — menus interleave with messages, drains and holds, and the queue
// is what sequences them (say/sayNext/act/actNext/waitNext, :833-963;
// updateQueue :1064) — plus intro (enter :1417), the FIGHT/PKMN/ITEM/RUN
// menu (:1856), move select (:1927), turn resolution (resolveTurn :2296,
// executeAction :3140, performMove :3397), damage application (:3596),
// fainting/exp (:3624/:3694), catching (throwBall :4484), running
// (tryRun :4282), end-of-turn (:2409) and finish (:4610).
//
// v1 scope cuts, each flagged where it lands: trainer battles, ghosts,
// Safari, the old-man demo, link play, move subanimations (anim rows keep
// their queue shape and the MOVE_ANIM_PRE beat, nothing draws), sound, the
// pokédex, nicknaming, the box system, and the replace-move prompt.

import type { MoveDef, VoxelmonData } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import {
  accuracyRoll as damageAccuracyRoll,
  compute as damageCompute,
  GEN1_FAITHFUL,
  type DamageInfo,
  type DamageMove,
  type Ruleset,
} from "../rules/damage.ts";
import { attempt as catchAttempt } from "../rules/catching.ts";
import { apply as expApply, movesLearnedAt } from "../rules/experience.ts";
import { beforeMove as statusBeforeMove, residual as statusResidual } from "../rules/status.ts";
import { effectiveSpeed, firstMover } from "../rules/turnorder.ts";
import { createTypeChart, type TypeChart } from "../rules/typechart.ts";
import {
  BATTLE_SLIDE_IN_FRAMES,
  BATTLE_START_SENDOUT,
  CRIT_OHKO_TEXT,
  FAINT_SLIDE,
  MOVE_ANIM_PRE,
  TEXT_PRE_ADVANCE,
  TEXT_SCROLL_PAIR,
  YES_NO_ANSWER,
  hpDrainClosingFrames,
  hpDrainStepFrames,
} from "../rules/timing.ts";
import { encodeGlyphs } from "../ui/tiles.ts";
import { animFrames, SIDE_ENEMY, SIDE_PLAYER, type AnimKind, type BattleAnim } from "./anim.ts";
import { MoveAnim, type AnimEvent, type AnimSprite as MoveAnimSprite } from "./moveanim.ts";

/** What a move's record carries for its sound (moves.json `anim`). */
interface MoveSoundDef {
  anim?: { sound?: string; pitch?: number; tempo?: number };
}
import { displayName, ghostText, makeBattler, prefixEnemy, type WildBattler } from "./battler.ts";
import {
  effectRecord,
  inflictStatus,
  makeCtx,
  runDamaging,
  warnUnknown,
  type AnimRowRef,
  type EffectBattle,
  type EffectMsgs,
  type HitFx,
} from "./effects.ts";
import { firstHealthy, newMon, partyAdd, markSeen, markOwned, type MoveSlot, type PartyMon } from "./mon.ts";

export type BattleResult = "win" | "lose" | "run" | "caught";

export type BattleButton = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select";

export interface BattleInput {
  isDown(btn: BattleButton): boolean;
  wasPressed(btn: BattleButton): boolean;
}

/**
 * One step through a single-column battle list, from ANY d-pad direction.
 *
 * DEVIATION, deliberate. The battle's action menu is a 2x2 grid, so all four
 * directions move its cursor; the move, item and party lists are single
 * columns, and vanilla leaves left/right dead in them. Pressing left on a
 * list that visibly responds to up therefore reads as the d-pad half-working
 * rather than as fidelity, so left/right step the same way up/down do.
 *
 * Each caller keeps its own edge behaviour: the move list wraps (vanilla
 * does), items and party clamp.
 */
function listStep(input: BattleInput): number {
  if (input.wasPressed("up") || input.wasPressed("left")) return -1;
  if (input.wasPressed("down") || input.wasPressed("right")) return 1;
  return 0;
}

/** Was any direction pressed this frame? */
function pressedDir(input: BattleInput): boolean {
  return (
    input.wasPressed("left") ||
    input.wasPressed("right") ||
    input.wasPressed("up") ||
    input.wasPressed("down")
  );
}

/**
 * Move a cursor around a GRID: `index` is 0-based, `cols` wide, `count`
 * entries, and the answer is where the press leaves it.
 *
 * The flat game's move list and party roster are single columns, so every
 * direction stepped the index by one and `listStep` was the whole rule.
 * The Kanto Gear draws both TWO TO A ROW (ui/kantogear.ts drawMoveSelect,
 * drawPartyList), and against that layout a press of DOWN moved the cursor
 * sideways. What a direction does is now what it looks like it does.
 *
 * A press into a cell past the end holds: the gear draws nothing there.
 */
function gridStep(input: BattleInput, index: number, cols: number, count: number): number {
  if (count <= 0) return index;
  const rows = Math.ceil(count / cols);
  let col = index % cols;
  let row = Math.floor(index / cols);
  if (input.wasPressed("left")) col = Math.max(0, col - 1);
  else if (input.wasPressed("right")) col = Math.min(cols - 1, col + 1);
  else if (input.wasPressed("up")) row = Math.max(0, row - 1);
  else if (input.wasPressed("down")) row = Math.min(rows - 1, row + 1);
  else return index;
  const next = row * cols + col;
  return next < count ? next : index;
}

/** How wide the gear lays the move grid and the party roster out. */
export const GEAR_GRID_COLS = 2;

/** The save slice the battle reads and mutates. */
export interface BattleSave {
  party: PartyMon[];
  inventory: Record<string, number>;
  player: { name: string; rival: string };
  /** Dex flags (markSeen/markOwned). Optional so an older save without the
   * block is a no-op rather than a type error. */
  pokedex?: { seen: Record<string, boolean>; owned: Record<string, boolean> };
  /** The OPTION screen's settings (ui/optionsmenu.ts). */
  options?: { textSpeed?: number; animations?: boolean };
}

// ---------------------------------------------------------------------------
// queue rows (BattleState.lua:833-963)
// ---------------------------------------------------------------------------

export interface QueueRow extends AnimRowRef {
  /** message row */
  text?: string;
  auto?: boolean;
  autoDelay?: number;
  choice?: (yes: boolean) => void;
  choiceOpen?: boolean;
  /** action row */
  fn?: () => void;
  /** animation row (v1: pays MOVE_ANIM_PRE, draws nothing) */
  anim?: string | null;
  hitRow?: boolean;
  attackerIsPlayer?: boolean;
  animDelayed?: boolean;
  shakes?: number;
  ball?: string;
  hit?: HitFx;
  /** HP-bar drain hold (drainNext :934) */
  drain?: boolean;
  battler?: WildBattler;
  stopAt?: number;
  /** pure frame hold (waitNext :943) */
  wait?: number;
  /** the level-up stat window (PrintStatsBox; the Lua's ui row) */
  statBox?: PartyMon;
}

interface MsgLine {
  text: string;
  codes: number[];
  cont: boolean;
}

export interface MsgShown {
  text: string;
  codes: number[];
  revealed: number;
}

export type BattlePhase = "messages" | "menu" | "moveSelect" | "party" | "item" | "forget";

// BattleState.lua:1868 — frames the old man's demo hovers the battle menu
// before he opens his bag and throws.
const DEMO_MENU_HOLD = 130;

/** A turn's action: a move, or one of the locked specials. */
export type BattleAction = MoveSlot & {
  struggle?: boolean;
  special?: "recharge" | "bound" | "trapping" | "bide";
};

/** :380-387 CHARGE_TEXT — ChargeEffect's per-move lines. */
const CHARGE_TEXT: Record<string, string> = {
  FLY: "%s\nflew up high!",
  DIG: "%s\ndug a hole!",
  RAZOR_WIND: "%s\nmade a whirlwind!",
  SOLARBEAM: "%s\ntook in sunlight!",
  SKULL_BASH: "%s\nlowered its head!",
  SKY_ATTACK: "%s\nis glowing!",
};

/** :2925-2931 SLOW_SHAKE_EFFECTS — status effects whose landing plays the
 * slow target shake. */
const SLOW_SHAKE_EFFECTS = new Set([
  "SLEEP_EFFECT",
  "POISON_EFFECT",
  "CONFUSION_EFFECT",
  "DISABLE_EFFECT",
  "ATTACK_DOWN1_EFFECT",
  "DEFENSE_DOWN1_EFFECT",
  "DEFENSE_DOWN2_EFFECT",
  "SPEED_DOWN1_EFFECT",
  "ACCURACY_DOWN1_EFFECT",
]);

export class WildBattle implements EffectBattle {
  readonly kind = "wild";
  readonly data: VoxelmonData;
  /** The battle rng stream. Tests may swap it after construction (the
   * harness.lua injection style — rng.ts). */
  rng: Rng;
  readonly save: BattleSave;
  /** Every message row as it starts typing, in queue order — the queue
   * discipline the tests pin (say -> act -> damage -> say ...). */
  readonly messageLog: string[] = [];
  readonly ruleset: Ruleset = GEN1_FAITHFUL;
  readonly chart: TypeChart;

  player!: WildBattler;
  enemy!: WildBattler;
  dead = false;

  queue: QueueRow[] = [];
  phase: BattlePhase = "messages";
  /** The move a full-moveset mon is being offered, and which mon. */
  private learnPending: { mon: PartyMon; moveId: string } | null = null;
  forgetIndex = 0;
  private hmCache: Set<string> | null = null;
  afterQueue: "menu" | "finish" = "menu";
  menuIndex = 1;
  moveIndex = 1;
  moveSwapIndex: number | null = null;
  frame = 0;
  /** move index -> its record, for the animation rows' sound bytes. */
  private moveSfxIndex: Map<number, MoveSoundDef> | null = null;
  /** The move animation drawing over the cards, and the frame it is on.
   * Compiled when the anim row runs; dropped when it has played out. */
  moveAnim: MoveAnim | null = null;
  moveAnimFrame = 0;
  private moveAnimDefender = SIDE_ENEMY;
  turnCount = 0;
  runAttempts = 0;
  lastDamage = 0;
  result: BattleResult | null = null;
  /** Set once finish() ran; the shell pops the state and stages the return. */
  finished: BattleResult | null = null;

  /**
   * Audio cues queued AT THE REFERENCE'S OWN CALL SITES and drained once per
   * tick by the shell's policy (game.ts driveAudio). The battle names them
   * (`cry:<species>`, `music:victory`, `music:restore`); it never touches the
   * surface. Watching battle state from outside got the cues right but their
   * ORDER wrong — the cry fired before the silhouettes landed, the victory
   * theme a text box late, the map theme ten ticks after teardown.
   */
  readonly audioCues: string[] = [];

  // presentation flags the ui reads (enter() windows, BattleState.lua:1459+)
  introBalls = true;
  showPlayerBack = true;
  sendingOut = false;
  blackedOut = false;
  /** SE_HIDE_ENEMY_MON_PIC (:1174) — the ball chain takes the pic away. */
  enemyHidden = false;
  lastBall: string | null = null;

  /** Balls are dodged instead of rolling a catch — the POKEMON TOWER 6F
   * RESTLESS SOUL (item_effects.asm:166-175). Set by the script that opens
   * the battle, not inferred from the disguise: vanilla dodges the ball with
   * or without the SILPH SCOPE. */
  noCatch = false;

  /** The enemy is the GHOST the SILPH SCOPE has not identified yet
   * (core.asm:6698-6700 InitWildBattle). Gates the name shown, the pic, the
   * "too scared to move" turn and the ghost's own "Get out..." turn; the
   * scope buys the unveil, not the battle. */
  disguised = false;
  /** What the disguise covers, put back when the scope unveils it. */
  ghostRealName = "";
  /**
   * The RESTLESS SOUL with the SILPH SCOPE in the bag. Mechanically not a
   * ghost battle at all -- IsGhostBattle returns false the moment the scope
   * is carried -- but InitWildBattle still enters disguised, and taking the
   * disguise off is PrintBeginningBattleText .isMarowak's job: the unveil
   * line, then the real name. The disguise is dropped in the intro.
   */
  scopeReveal = false;
  /** A rod's catch: "The hooked X attacked!" rather than "appeared". */
  hooked = false;

  /**
   * Pokemon Tower ghosts (core.asm InitWildBattle .isGhost): the disguise
   * swaps only the name and the pic -- the species underneath is real, so
   * stats and the SGB palette stay the disguised mon's.
   */
  makeGhost(): void {
    this.disguised = true;
    this.ghostRealName = this.enemy.name;
    this.enemy.name = "GHOST";
  }

  /** The 6F MAROWAK with the scope carried: disguised for the intro only. */
  makeUnveiledGhost(): void {
    this.makeGhost();
    this.scopeReveal = true;
  }

  // BATTLE_TYPE_OLD_MAN demo state (BattleState.lua:806-835, :2160-2210). The
  // Viridian catch tutorial: no player mon acts, the old man auto-throws one
  // POKé BALL, nothing is kept. `oakDemo`/`demoFails` carry Yellow's variants
  // (PROF.OAK pic, initial-training breakout #636); Red/Blue Viridian uses
  // neither.
  demo = false;
  demoName = "OLD MAN";
  demoFails = false;
  oakDemo = false;
  private demoTimer = 0;

  // queue pump state (updateQueue :1064)
  private nextInsert = 0;
  private waitFrames = 0;
  private draining = false;
  moveAnimRow: QueueRow | null = null;
  /** Running card animations, at most one per side (battle/anim.ts).
   * staging.ts reads these to offset the cards it asks the scene for. */
  anims: BattleAnim[] = [];
  current: QueueRow | null = null;
  statBoxMon: PartyMon | null = null;

  // message machine state (startMessage :1021)
  private lines: MsgLine[] = [];
  private lineIndex = 0;
  private codes: number[] = [];
  shown: MsgShown[] = [];
  msgWaiting = false;
  private msgPreWait = 0;
  msgPrompt = false;
  private msgPromptWait = 0;
  private msgAutoWait: number | null = null;
  msgHold = false;
  private charTimer = 0;
  choiceOpen = false;
  choiceYes = true;
  /** The answer given, held on screen (ChoiceBox.lua:34) before it lands. */
  private choicePending: boolean | null = null;
  private choiceHold = 0;

  // party / item menus (v1 internal phases in place of the Lua's ui stack)
  partyIndex = 0;
  partyForced = false;
  itemIndex = 0;
  itemList: string[] = [];

  private participants = new Set<PartyMon>();
  /** mons that leveled up; game.ts runs Evolution.checkParty on the way out. */
  leveledUp = new Set<PartyMon>();

  /**
   * BattleState.newWild (:576-594). The enemy mon's DVs consume the battle
   * rng stream; the overworld streams are untouched.
   */
  constructor(data: VoxelmonData, save: BattleSave, rng: Rng, species: string, level: number) {
    this.data = data;
    this.save = save;
    this.rng = rng;
    this.chart = createTypeChart(data.type_chart);
    const playerMon = firstHealthy(save.party);
    if (!playerMon) {
      // :580-583 — flagged dead; enter() takes the blackout path (#425)
      this.dead = true;
    } else {
      this.player = makeBattler(data, playerMon, true, save);
    }
    this.enemy = makeBattler(data, newMon(data, species, level, rng), false);
    if (this.dead) {
      // keep the shared phases nil-safe like makeOldManDemo (:810-817)
      this.player = this.enemy;
    }
  }

  /**
   * BattleState.lua:806-835 makeOldManDemo. Turns this wild battle into the
   * BATTLE_TYPE_OLD_MAN catch tutorial: no player mon acts, the battle menu
   * appears under the old man's name, and one POKé BALL is thrown at the wild
   * mon. `name` is the thrower (Yellow's Pallet intro passes "PROF.OAK" for
   * BATTLE_TYPE_PIKACHU, which also picks ProfOakPicBack); `failThrow` is
   * Yellow's initial training only (#636). Red/Blue Viridian passes neither.
   */
  makeOldManDemo(name?: string, failThrow?: boolean): void {
    this.demo = true;
    this.demoName = name ?? "OLD MAN";
    this.demoFails = !!failThrow;
    this.oakDemo = name === "PROF.OAK";
    // Yellow's intro runs this before the player owns a mon, so newWild flagged
    // the battle dead; a hidden placeholder keeps the shared phases nil-safe.
    // In Red/Blue Viridian the player has a party, so this never fires.
    if (this.dead || !this.player) {
      this.dead = false;
      this.player = makeBattler(
        this.data,
        newMon(this.data, this.enemy.mon.species, 5, this.rng),
        true,
        this.save,
      );
    }
  }

  /**
   * BattleState.lua:2197-2210 oldManThrow. The old man throws one POKé BALL.
   * Red/Blue always catch (ItemUseBall's old-man branch jumps straight to
   * .captured), and .oldManCaughtMon prints the caught text WITHOUT adding the
   * mon to the party or the dex (item_effects.asm:568-570). No ball is
   * consumed. result="run" only ends the demo — the party is healthy, so
   * finish() will not force a blackout.
   */
  oldManThrow(): void {
    this.phase = "messages";
    this.afterQueue = "finish";
    this.result = "run";
    this.sayAuto(`${this.demoName} used\nPOKé BALL!`);
    this.act(() => {
      // ItemUseBall's 20-frame beat, then the toss/shake chain, exactly like
      // throwBall's caught path (the anim rows carry the Ball_Toss cue and set
      // enemyHidden). demoFails (#636) would break out here — Yellow only.
      this.insertNext({ wait: 20 });
      this.ballChain(true, 3, "POKE_BALL");
      this.sayNext(`All right!\n${this.enemy.name} was\ncaught!`);
    });
  }

  // -------------------------------------------------------------------
  // queue builders (:833-963)
  // -------------------------------------------------------------------

  say(text: string): void {
    this.queue.push({ text });
  }

  /** :843-845 sayAuto — a `text_end` page: never waits on the player. */
  sayAuto(text: string, delay = 0): void {
    this.queue.push({ text, auto: true, autoDelay: delay });
  }

  /** :849-851 sayChoice — YES/NO over the still-visible text. */
  sayChoice(text: string, onChoose: (yes: boolean) => void): void {
    this.queue.push({ text, choice: onChoose });
  }

  act(fn: () => void): void {
    this.queue.push({ fn });
  }

  private insertNext(row: QueueRow): void {
    this.nextInsert += 1;
    this.queue.splice(this.nextInsert - 1, 0, row);
  }

  /** :867-872 animNext. */
  animNext(name: string, isPlayer: boolean, shakes?: number, ball?: string): void {
    this.insertNext({ anim: name, attackerIsPlayer: isPlayer, shakes, ball });
  }

  /** :874-878 actNext. */
  actNext(fn: () => void): void {
    this.insertNext({ fn });
  }

  /** :880-885 sayNext. */
  sayNext(text: string): void {
    this.insertNext({ text });
  }

  /** :887-892 sayNextAuto. */
  sayNextAuto(text: string, delay = 0): void {
    this.insertNext({ text, auto: true, autoDelay: delay });
  }

  /** :896-899 uiNext, narrowed to the one ui row v1 needs (StatBox). */
  statBoxNext(mon: PartyMon): void {
    this.insertNext({ statBox: mon });
  }

  /** :934-938 drainNext. */
  drainNext(battler?: WildBattler, stopAt?: number): void {
    this.insertNext({ drain: true, battler, stopAt });
  }

  /** :943-947 waitNext. */
  waitNext(frames: number): void {
    if (!frames || frames <= 0) return;
    this.insertNext({ wait: frames });
  }

  /** EffectRegistry hit rows (:227-241) — insert + return for `.hit`. */
  insertHitRow(anim: string | null, isPlayer: boolean): QueueRow {
    const row: QueueRow = anim
      ? { anim, attackerIsPlayer: isPlayer }
      : { hitRow: true, attackerIsPlayer: isPlayer };
    this.insertNext(row);
    return row;
  }

  /** :2511-2529 cancelMoveAnim — peel the announcement-time anim row. */
  cancelMoveAnim(): void {
    const row = this.moveAnimRow;
    if (!row) return;
    this.moveAnimRow = null;
    const i = this.queue.indexOf(row);
    if (i >= 0) {
      this.queue.splice(i, 1);
      if (i < this.nextInsert) this.nextInsert -= 1;
    }
  }

  // -------------------------------------------------------------------
  // HP-bar drain (stepHPDrain :964-1002)
  // -------------------------------------------------------------------

  private stepHPDrain(): boolean {
    let busy = false;
    for (const b of [this.player, this.enemy]) {
      if (!b) continue;
      let goal = b.mon.hp;
      if (b.drainFloor !== undefined && b.drainFloor > goal && b.shownHP >= b.drainFloor) {
        goal = b.drainFloor;
      }
      if ((b.drainHold ?? 0) > 0) {
        b.drainHold = (b.drainHold ?? 0) - 1;
        busy = true;
      } else if (b.shownHP !== goal) {
        const maxHP = Math.max(1, b.mon.stats.hp);
        const playerSide = b === this.player;
        let cost = 0;
        while (b.shownHP !== goal && cost < 1) {
          const nextHP = b.shownHP + (b.shownHP > goal ? -1 : 1);
          cost += hpDrainStepFrames(b.shownHP, nextHP, maxHP, playerSide);
          b.shownHP = nextHP;
        }
        b.drainHold = Math.max(0, cost - 1);
        b.draining = true;
        busy = true;
      } else if (b.draining) {
        b.draining = undefined;
        b.drainHold = hpDrainClosingFrames(b === this.player) - 1;
        busy = true;
      }
    }
    return busy;
  }

  // -------------------------------------------------------------------
  // message machine (startMessage :1021, beginMsgLine :1053)
  // -------------------------------------------------------------------

  private startMessage(item: QueueRow): void {
    this.current = item;
    this.lines = [];
    const text = item.text ?? "";
    this.messageLog.push(text);
    let pos = 0;
    let cont = false;
    for (;;) {
      const npos = text.slice(pos).search(/[\n\v]/);
      const chunk = npos < 0 ? text.slice(pos) : text.slice(pos, pos + npos);
      this.lines.push({ text: chunk, codes: encodeGlyphs(chunk), cont });
      if (npos < 0) break;
      cont = text[pos + npos] === "\v";
      pos += npos + 1;
    }
    this.shown = [];
    this.lineIndex = 0;
    this.msgWaiting = false;
    this.msgPrompt = false;
    this.msgAutoWait = null;
    this.msgHold = false;
    this.beginMsgLine();
  }

  private beginMsgLine(): void {
    this.lineIndex += 1;
    const ln = this.lines[this.lineIndex - 1];
    this.codes = ln ? ln.codes : [];
    if (this.shown.length >= 2) {
      // ScrollTextUpOneLine — instantaneous on the tile grid; the
      // TEXT_SCROLL_PAIR hold after a CONT keeps the pacing (:1250-1252)
      this.shown.shift();
    }
    this.shown.push({ text: ln ? ln.text : "", codes: this.codes, revealed: 0 });
  }

  // -------------------------------------------------------------------
  // the queue pump (updateQueue :1064-1343). Returns true while busy.
  // -------------------------------------------------------------------

  updateQueue(input: BattleInput): boolean {
    // the level-up stat window pauses the queue until A/B (StatBox :409-415)
    if (this.statBoxMon) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.statBoxMon = null;
      }
      return true;
    }
    if (this.waitFrames > 0) {
      this.waitFrames -= 1;
      return true;
    }
    // waitingSound (:1077-1081): no audio in the voxel v1 slice
    if (this.draining) {
      if (this.stepHPDrain()) return true;
      this.draining = false;
      if (this.player) this.player.drainFloor = undefined;
      if (this.enemy) this.enemy.drainFloor = undefined;
    }
    if (!this.current) {
      const item = this.queue.shift();
      if (!item) return false;
      if (item.fn) {
        this.nextInsert = 0; // sayNext inserts right after this item (:1114)
        item.fn();
        this.current = null;
        return true;
      }
      if (item.statBox) {
        this.statBoxMon = item.statBox;
        return true;
      }
      if (item.drain) {
        this.draining = true;
        if (item.battler) item.battler.drainFloor = item.stopAt;
        return true;
      }
      if (item.wait !== undefined) {
        this.waitFrames = item.wait;
        return true;
      }
      if (item.anim !== undefined || item.hitRow) {
        // :1174-1177 — HIDEPIC/SHOWPIC are ENGINE state, not animation
        // state: the assignment sits before the animation-player block, so
        // it happens with animations off too. The ball chain hides the wild
        // mon while the ball shakes and brings it back on a breakout.
        if (item.anim === "HIDEPIC_ANIM") this.enemyHidden = true;
        else if (item.anim === "SHOWPIC_ANIM") this.enemyHidden = false;
        // PlayMoveAnimation's Delay3 before the first animation frame
        // (:1158-1167). The row then compiles the move's subanimations and
        // holds the queue for exactly as long as they play; a move with no
        // animation data of its own falls back to the lunge alone, which is
        // the Lua's own no-animPlayer path (:1209-1230).
        if (item.anim && !item.animDelayed) {
          item.animDelayed = true;
          this.queue.unshift(item);
          this.waitFrames = MOVE_ANIM_PRE;
          return true;
        }
        // The attacker lunges; if this row landed damage (effects.ts sets
        // `hit` only when dealt > 0) the defender is knocked back and
        // flickers with it. The move's own animation draws over that. A
        // status move or a miss lunges alone. HIDEPIC/SHOWPIC handled above
        // are engine state, not a move, and animate nothing.
        const engineRow = item.anim === "HIDEPIC_ANIM" || item.anim === "SHOWPIC_ANIM";
        if (!engineRow && item.attackerIsPlayer !== undefined) {
          const attacker = item.attackerIsPlayer ? SIDE_PLAYER : SIDE_ENEMY;
          const defender = item.attackerIsPlayer ? SIDE_ENEMY : SIDE_PLAYER;
          let hold = this.startAnim("lunge", attacker);
          if (item.hit) hold = Math.max(hold, this.startAnim("hit", defender));
          // PlayApplyingAttackSound, on the beat the knock lands. The tempo
          // byte is deliberately not carried: the noise channel ignores it.
          const hs = typeof item.hit === "object" ? item.hit?.sfx : null;
          if (hs?.sound) this.audioCues.push(`move:${hs.sound}:${hs.pitch}:0`);
          const played = this.startMoveAnim(item.anim, item.attackerIsPlayer, defender, item);
          hold = Math.max(hold, played);
          this.waitFrames = hold;
        }
        this.current = null;
        return true;
      }
      this.startMessage(item);
    }
    // \v CONT wait (:1239-1255)
    if (this.msgWaiting) {
      if (this.msgPreWait > 0) {
        this.msgPreWait -= 1;
        return true;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.msgWaiting = false;
        this.beginMsgLine();
        this.waitFrames = TEXT_SCROLL_PAIR;
      }
      return true;
    }
    const cur = this.shown[this.shown.length - 1];
    if (cur.revealed < this.codes.length) {
      // PrintLetterDelay cadence (:1256-1274): OPTION text speed 3, or a
      // single frame while A/B is held
      let delay = 3;
      if (input.isDown("a") || input.isDown("b")) delay = 1;
      this.charTimer += 1;
      while (this.charTimer >= delay && cur.revealed < this.codes.length) {
        this.charTimer -= delay;
        cur.revealed += 1;
      }
    } else if (this.lineIndex < this.lines.length) {
      if (this.lines[this.lineIndex].cont) {
        this.msgWaiting = true;
        this.msgPreWait = TEXT_PRE_ADVANCE;
      } else {
        this.beginMsgLine();
      }
    } else {
      const item = this.current;
      // choice rows open YES/NO over the typed text (:1288-1299)
      if (item?.choice && !item.choiceOpen) {
        item.choiceOpen = true;
        this.choiceOpen = true;
        this.choiceYes = true;
        return true;
      }
      if (item?.choice && this.choiceOpen) {
        // ChoiceBox.lua:34-45: the answer is held on screen for
        // YES_NO_ANSWER frames before control comes back — both branches of
        // DisplayTwoOptionMenu pay it (engine/menus/text_box.asm:322,:333).
        if (this.choicePending !== null) {
          this.choiceHold -= 1;
          if (this.choiceHold <= 0) {
            const answer = this.choicePending;
            const fn = item.choice;
            this.choicePending = null;
            this.choiceOpen = false;
            this.current = null;
            fn(answer);
          }
          return true;
        }
        if (input.wasPressed("up") || input.wasPressed("down")) {
          this.choiceYes = !this.choiceYes;
        } else if (input.wasPressed("a")) {
          // HandleMenuInput_ (home/window.asm) beeps on A and B alike
          this.audioCues.push("sfx:Press_AB");
          this.choicePending = this.choiceYes;
          this.choiceHold = YES_NO_ANSWER;
        } else if (input.wasPressed("b")) {
          this.audioCues.push("sfx:Press_AB");
          // .choseSecondMenuItem snaps the cursor to NO for the hold
          this.choiceYes = false;
          this.choicePending = false;
          this.choiceHold = YES_NO_ANSWER;
        }
        return true;
      }
      if (item?.auto) {
        // `text_end` pages never wait on the player (:1300-1317, #765)
        this.msgAutoWait = this.msgAutoWait ?? item.autoDelay ?? 0;
        if (this.msgAutoWait > 0) {
          this.msgAutoWait -= 1;
        } else {
          this.msgAutoWait = null;
          this.msgHold = true;
          this.current = null;
        }
      } else {
        // PromptText's ▼ + ProtectedDelay3 before the page can be
        // dismissed (:1318-1339, #317)
        if (!this.msgPrompt) {
          this.msgPrompt = true;
          this.msgPromptWait = TEXT_PRE_ADVANCE;
        }
        if (this.msgPromptWait > 0) {
          this.msgPromptWait -= 1;
        } else if (input.wasPressed("a") || input.wasPressed("b")) {
          this.msgPrompt = false;
          this.current = null;
        }
      }
    }
    return true;
  }

  // -------------------------------------------------------------------
  // intro (enter :1417-1622, wild slice)
  // -------------------------------------------------------------------

  enter(): void {
    if (this.dead) {
      // :1417-1447 — no healthy party: black out instead of skipping (#425).
      // v1 prints the two paragraphs on the battle screen (no map TextBox).
      this.result = "lose";
      this.say(`${this.save.player.name} is out of\nuseable POKéMON!`);
      this.say(`${this.save.player.name} blacked\nout!`);
      this.phase = "messages";
      this.afterQueue = "finish";
      return;
    }
    // SlidePlayerAndEnemySilhouettesOnScreen: nothing queued starts until
    // the slide has landed (:1465 introSlide + :1793-1802); the voxel v1
    // has no silhouettes, so the hold rides the queue instead.
    this.queue.push({ wait: BATTLE_SLIDE_IN_FRAMES });
    // PrintBeginningBattleText (:1496-1510, common_text.asm:10-19, #303): a
    // wild battle calls PlayCry BEFORE the "appeared!" box, so the cry lands
    // with the text — after the silhouettes have slid in, not on the frame
    // the battle was pushed.
    this.enemyIntro();
    // _InitBattleCommon clears the intro chrome the instant the intro text
    // is dismissed (:1534-1539, #317)
    this.act(() => {
      this.introBalls = false;
    });
    // StartBattle's unconditional `ld c, 40 / call DelayFrames` (:1580-1587)
    if (this.sendsPlayerMon()) {
      this.queue.push({ wait: BATTLE_START_SENDOUT });
      // the back pic walks off before "Go! X!" (:1588-1599, #317): 18 frames
      this.queue.push({ wait: 18 });
      this.act(() => {
        this.showPlayerBack = false;
        this.sendingOut = true;
      });
      this.say(this.sendOutText(this.player.name));
      this.queue.push({ anim: "POOF_ANIM", attackerIsPlayer: false });
      this.act(() => {
        this.sendingOut = false;
        // AnimateSendingOutMon grow-in + cry (:1604-1610) — later rung
      });
    }
    // BATTLE_TYPE_OLD_MAN sends out no player mon; leaving showPlayerBack true
    // keeps the player sprite + HUD hidden for the whole demo (staging.ts:99,
    // ui.ts:162 — hidePlayer = self.demo, BattleState.lua:5397).
    this.markParticipant();
    this.phase = "messages";
    this.afterQueue = "menu";
  }

  /** The enemy-appears line. Wild: "X appeared!" with its cry. Trainers
   * override this for "TRAINER sent out X!" (common_text.asm). */
  enemyIntro(): void {
    if (this.disguised) {
      // A ghost gets no cry (common_text.asm:43-48), and is not "seen":
      // nothing was identified.
      this.say("The GHOST\nappeared!");
      if (this.scopeReveal) {
        // .isMarowak: the unveil line over the disguise, then the real
        // name and pic, then the ordinary appeared line under it.
        this.say(ghostText(this.data, "_UnveiledGhostText",
          "SILPH SCOPE\nunveiled the\nGHOST's identity!"));
        this.act(() => {
          this.disguised = false;
          this.enemy.name = this.ghostRealName;
          markSeen(this.save, this.enemy.mon.species);
          this.audioCues.push(`cry:${this.enemy.mon.species}`);
        });
        this.say(`Wild ${this.ghostRealName}\nappeared!`);
      }
      return;
    }
    markSeen(this.save, this.enemy.mon.species); // BattleState.lua:596 — wild mon appears -> seen
    this.act(() => this.audioCues.push(`cry:${this.enemy.mon.species}`));
    if (this.hooked) {
      // _HookedMonAttackedText: a bite is an attack, not an appearance.
      this.say(ghostText(this.data, "_HookedMonAttackedText",
        "The hooked\n{RAM:wEnemyMonNick}\nattacked!")
        .replace("{RAM:wEnemyMonNick}", this.enemy.name));
      return;
    }
    this.say(`Wild ${this.enemy.name}\nappeared!`);
  }

  /** :1353-1363 sendOutText — the shout scales with enemy HP remaining. */
  sendOutText(name: string): string {
    const e = this.enemy.mon;
    let pct = 100;
    if (e.hp > 0 && Math.floor(e.stats.hp / 4) > 0) {
      pct = Math.floor((e.hp * 25) / Math.floor(e.stats.hp / 4));
    }
    if (pct >= 70) return `Go! ${name}!`;
    if (pct >= 40) return `Do it! ${name}!`;
    if (pct >= 10) return `Get'm! ${name}!`;
    return `The enemy's weak!\nGet'm! ${name}!`;
  }

  /** Exp participants (wPartyGainExpFlags, :2257-2262). */
  markParticipant(): void {
    if (this.player?.mon) this.participants.add(this.player.mon);
  }

  // -------------------------------------------------------------------
  // update (:1777-1998) — one call per fixed step
  // -------------------------------------------------------------------

  /**
   * Start a card animation and return the frames it runs for, so the caller
   * can hold the queue exactly that long. One per side: a second animation
   * on the same card replaces the first rather than fighting it.
   */
  /**
   * The battle theme's role (BattleState.lua:1394 computeMusicKind), read by
   * game.ts when the battle opens. A wild battle is always "wild"; the
   * trainer subclass picks between "trainer", "gym" and "final".
   */
  musicKind(): string {
    return "wild";
  }

  /**
   * The victory theme to start as this enemy mon's faint slide lands, or null
   * when the battle is not over yet. Wild: the faint IS the win.
   */
  protected victoryMusicKind(): string | null {
    return "wild";
  }

  /** BattleState.lua:2544 animationsOn — the OPTION toggle; sounds stay. */
  animationsOn(): boolean {
    return this.save.options?.animations !== false;
  }

  /**
   * The SAFARI menu, when this is one (battle/safari.ts overrides it).
   * Returns true when it handled the phase.
   */
  protected safariMenu(_input: BattleInput): boolean {
    return false;
  }

  /**
   * Does the player send a mon out at all? BATTLE_TYPE_OLD_MAN does not, and
   * neither does a SAFARI battle — leaving showPlayerBack true is what keeps
   * the player's sprite and HUD hidden for the whole thing (staging.ts:116,
   * BattleState.lua:5397).
   */
  protected sendsPlayerMon(): boolean {
    return !this.demo;
  }

  private startAnim(kind: AnimKind, side: number): number {
    // The toggle gates MOVE animations only. The faint slide is
    // SlideDownFaintedMonPic, not a move animation, and always runs —
    // without it a mon would vanish rather than sink.
    if (kind !== "faint" && !this.animationsOn()) return 0;
    const total = animFrames(kind);
    this.anims = this.anims.filter((a) => a.side !== side);
    this.anims.push({ kind, side, frame: 0, total });
    return total;
  }

  /**
   * Compile a move's animation and start it over the cards; returns the
   * frames the queue owes it (0 when animations are off, the dataset has no
   * animation tables, or this id has no animation of its own).
   */
  private startMoveAnim(
    id: string | null | undefined,
    attackerIsPlayer: boolean,
    defender: number,
    opts: { shakes?: number; ball?: string },
  ): number {
    this.moveAnim = null;
    this.moveAnimFrame = 0;
    if (!id || !this.animationsOn()) return 0;
    const anim = new MoveAnim(this.data.battle_anims ?? null, id, attackerIsPlayer, {
      shakes: opts.shakes,
      ball: opts.ball,
    });
    if (anim.frames <= 0) return 0;
    this.moveAnim = anim;
    this.moveAnimDefender = defender;
    return anim.frames;
  }

  /** This frame's animation sprites, in OAM space (scene.ts places them). */
  animSprites(): MoveAnimSprite[] {
    return this.moveAnim ? this.moveAnim.spritesAt(this.moveAnimFrame) : [];
  }

  /**
   * A special effect the animation asked for, and the sound its row plays.
   *
   * The screen-level effects have a card equivalent here: the defender
   * takes the knock it takes on a hit. The sound is named by MOVE INDEX --
   * an animation row borrows whichever move's MoveSoundTable entry it wants
   * (TACKLE's rows play LEECH SEED's) -- and that entry carries the pitch
   * and tempo modifiers with it.
   */
  private applyAnimEvent(e: AnimEvent): void {
    if (e.sound !== undefined && e.sound !== null) {
      const def = this.moveByIndex(e.sound);
      const a = def?.anim;
      if (a?.sound) {
        this.audioCues.push(`move:${a.sound}:${a.pitch ?? 0}:${a.tempo ?? 0}`);
      }
    }
    if (!e.effect) return;
    if (e.effect.includes("SHAKE") || e.effect.includes("FLASH_SCREEN")) {
      this.startAnim("hit", this.moveAnimDefender);
    }
  }

  /** The move a MoveSoundTable index names (moves.json `index`). */
  private moveByIndex(index: number): MoveSoundDef | undefined {
    if (!this.moveSfxIndex) {
      this.moveSfxIndex = new Map();
      for (const def of Object.values(this.data.moves ?? {})) {
        const d = def as MoveSoundDef & { index?: number };
        if (typeof d.index === "number") this.moveSfxIndex.set(d.index, d);
      }
    }
    return this.moveSfxIndex.get(index);
  }

  update(input: BattleInput): void {
    this.frame += 1;
    if (this.moveAnim) {
      const from = this.moveAnimFrame;
      this.moveAnimFrame += 1;
      for (const e of this.moveAnim.eventsIn(from, this.moveAnimFrame)) this.applyAnimEvent(e);
      if (this.moveAnim.done(this.moveAnimFrame)) this.moveAnim = null;
    }
    if (this.anims.length > 0) {
      for (const a of this.anims) a.frame += 1;
      this.anims = this.anims.filter((a) => a.frame < a.total);
    }

    // menu-idle safety net (:1783-1791): HP/status changed outside a drain
    if (this.phase === "menu") {
      for (const b of [this.player, this.enemy]) {
        if (!b) continue;
        b.shownHP = b.mon.hp;
        b.drainFloor = undefined;
        b.shownStatus = b.mon.status ?? null;
      }
    }

    if (this.phase === "messages") {
      if (!this.updateQueue(input)) {
        if (this.afterQueue === "menu") {
          this.phase = "menu";
        } else {
          this.finish();
        }
      }
      return;
    }

    if (this.phase === "menu") {
      // A SAFARI battle's menu is a different four (battle/safari.ts), and
      // the player's mon never acts, so it takes the phase over entirely.
      if (this.safariMenu(input)) return;
      // BattleState.lua:1858-1870: a demo battle reads no input. The old man
      // hovers the menu, then opens his bag and throws. The port abstracts the
      // scripted list menu, so the hover leads straight into oldManThrow.
      if (this.demo) {
        this.demoTimer += 1;
        if (this.demoTimer > DEMO_MENU_HOLD) {
          this.demoTimer = 0;
          this.oldManThrow();
        }
        return;
      }
      // forced replacement after a faint (ChooseNextMon :1856-1865)
      if (this.player.mon.hp <= 0) {
        if (firstHealthy(this.save.party)) {
          this.openParty(true);
        }
        return;
      }
      this.clearTurnFlinches();
      // only recharge/Rage/thrash/charge skip DisplayBattleMenu; trapping
      // victims (and wrappers) still get FIGHT/PKMN/ITEM/RUN (core.asm:312)
      const locked = this.menuLockedAction(this.player);
      if (locked) {
        this.resolveTurn(locked);
        return;
      }
      const col0 = (this.menuIndex - 1) % 2;
      const row0 = Math.floor((this.menuIndex - 1) / 2);
      let col = col0;
      let row = row0;
      if (input.wasPressed("left")) col = Math.max(0, col - 1);
      else if (input.wasPressed("right")) col = Math.min(1, col + 1);
      else if (input.wasPressed("up")) row = Math.max(0, row - 1);
      else if (input.wasPressed("down")) row = Math.min(1, row + 1);
      this.menuIndex = row * 2 + col + 1;
      if (input.wasPressed("a")) {
        const choice = (["fight", "pkmn", "item", "run"] as const)[this.menuIndex - 1];
        if (choice === "fight") {
          // own trapping/Bide or foe Wrap skips the move list and forces
          // the locked action (core.asm:320-329)
          const fightLock = this.fightLockedAction(this.player);
          if (fightLock) {
            this.resolveTurn(fightLock);
            return;
          }
          if (!this.playerHasPP()) {
            // _NoMovesLeftText then Struggle (:1907-1911)
            this.say(`${this.player.name} has no\nmoves left!`);
            this.resolveTurn({ id: "STRUGGLE", pp: 1, struggle: true });
            return;
          }
          this.phase = "moveSelect";
          this.moveIndex = Math.min(this.moveIndex, this.player.curMoves.length);
          this.moveSwapIndex = null;
        } else if (choice === "run") {
          this.tryRun();
        } else if (choice === "item") {
          this.openItems();
        } else {
          this.openParty(false);
        }
      }
      return;
    }

    if (this.phase === "moveSelect") {
      const moves = this.player.curMoves;
      if (pressedDir(input)) {
        // The moves are drawn two to a row, so the cursor moves the way
        // the d-pad is pushed rather than stepping down a list that is
        // not there (gridStep).
        this.moveIndex =
          gridStep(input, this.moveIndex - 1, GEAR_GRID_COLS, moves.length) + 1;
      } else if (input.wasPressed("select")) {
        // SELECT swap (:1940-1946)
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
        } else {
          this.moveSwapIndex = this.moveIndex;
        }
      } else if (input.wasPressed("b")) {
        this.moveSwapIndex = null;
        this.phase = "menu";
      } else if (input.wasPressed("a")) {
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
          return;
        }
        const mv = moves[this.moveIndex - 1];
        if (this.player.disabledSlot === this.moveIndex) {
          this.say("The move is\ndisabled!");
          this.phase = "messages";
          this.afterQueue = "menu";
        } else if (mv.pp <= 0) {
          this.say("No PP left for\nthis move!");
          this.phase = "messages";
          this.afterQueue = "menu";
        } else {
          this.resolveTurn(mv);
        }
      }
      return;
    }

    if (this.phase === "forget") {
      this.updateForget(input);
      return;
    }
    if (this.phase === "party") {
      this.updateParty(input);
      return;
    }
    if (this.phase === "item") {
      this.updateItems(input);
      return;
    }
  }

  /** :1734-1738 clearTurnFlinches — skipped for a mon that must recharge
   * or is locked into Rage (the Hyper Beam flinch glitch). */
  private clearTurnFlinches(): void {
    for (const b of [this.player, this.enemy]) {
      if (b && !(b.mustRecharge || b.rageMove)) b.flinched = false;
    }
  }

  /** :1744-1750 menuLockedAction — recharge, charge, thrash, Rage skip the
   * menu entirely. */
  menuLockedAction(b: WildBattler): BattleAction | null {
    if (b.mustRecharge) return { id: "", pp: 0, special: "recharge" };
    if (b.charging) return b.charging;
    if (b.thrashTurns !== undefined && b.thrashTurns > 0 && b.thrashMove) return b.thrashMove;
    if (b.rageMove) return b.rageMove;
    return null;
  }

  /** :1754-1774 fightLockedAction — own trapping/Bide continue; a foe's
   * trap holds this one in place. */
  fightLockedAction(b: WildBattler): BattleAction | null {
    if (b.trappingTurns !== undefined && b.trappingTurns > 0) {
      return { id: "", pp: 0, special: "trapping" };
    }
    if (b.bideTurns !== undefined) return { id: "", pp: 0, special: "bide" };
    const opp = b.isPlayer ? this.enemy : this.player;
    if (opp && opp.trappingTurns !== undefined) return { id: "", pp: 0, special: "bound" };
    return null;
  }

  /** :1777-1779 lockedAction. */
  lockedAction(b: WildBattler): BattleAction | null {
    return this.menuLockedAction(b) ?? this.fightLockedAction(b);
  }

  /** :1736-1741 playerHasPP. */
  playerHasPP(): boolean {
    return this.player.curMoves.some(
      (mv, i) => mv.pp > 0 && this.player.disabledSlot !== i + 1,
    );
  }

  /** :1743-1760 swapMoves — curMoves aliases mon.moves, one swap does both. */
  private swapMoves(i: number, j: number): void {
    if (i === j) return;
    const moves = this.player.curMoves;
    const a = moves[i - 1];
    const b = moves[j - 1];
    if (!a || !b) return;
    moves[i - 1] = b;
    moves[j - 1] = a;
    if (this.player.disabledSlot === i) this.player.disabledSlot = j;
    else if (this.player.disabledSlot === j) this.player.disabledSlot = i;
  }

  // -------------------------------------------------------------------
  // turn resolution (:2266-2331)
  // -------------------------------------------------------------------

  /**
   * vanillaEnemyAction (:2275-2289) + TrainerAI.chooseMove (:226-252): a
   * wild enemy picks a UNIFORM RANDOM usable move — under gen1_faithful
   * SelectEnemyMove never consults enemy PP — and Struggles only when every
   * slot is missing or disabled.
   */
  enemyAction(): BattleAction {
    const locked = this.lockedAction(this.enemy);
    if (locked) return locked;
    const usable: MoveSlot[] = [];
    this.enemy.curMoves.forEach((mv, i) => {
      if (this.enemy.disabledSlot !== i + 1 && (this.ruleset.enemyUnlimitedPP || mv.pp > 0)) {
        usable.push(mv);
      }
    });
    if (usable.length === 0) return { id: "STRUGGLE", pp: 1, struggle: true };
    return usable[randRange(this.rng, 1, usable.length) - 1];
  }

  /** :2296-2331 resolveTurn. */
  resolveTurn(playerAction: BattleAction): void {
    const enemyAction = this.enemyAction();
    this.turnCount += 1;
    const pMove = this.data.moves[playerAction.id] ?? null;
    const eMove = this.data.moves[enemyAction.id] ?? null;
    const pFirst = firstMover(this.player, pMove, this.enemy, eMove, this.rng);
    const order: [WildBattler, WildBattler, BattleAction][] = pFirst
      ? [
          [this.player, this.enemy, playerAction],
          [this.enemy, this.player, enemyAction],
        ]
      : [
          [this.enemy, this.player, enemyAction],
          [this.player, this.enemy, playerAction],
        ];
    this.phase = "messages";
    this.afterQueue = "menu";
    for (const [user, target, action] of order) {
      this.act(() => {
        this.executeAction(user, target, action);
      });
    }
    this.act(() => {
      this.endOfTurn();
    });
  }

  // -------------------------------------------------------------------
  // residuals / end of turn (:2367-2462)
  // -------------------------------------------------------------------

  private residualAfterMove(): boolean {
    return this.ruleset.residualAfterMove !== false;
  }

  /** :2380-2399 residualFor — one side, right after its action. */
  residualFor(b: WildBattler, opp: WildBattler): void {
    if (this.result) return;
    if (this.player !== b && this.enemy !== b) return;
    if (b.mon.hp <= 0 || opp.mon.hp <= 0) return;
    const msgs = statusResidual(b, opp);
    for (const m of msgs) this.sayNext(prefixEnemy(m, b));
    if (b.leechSeeded && b.mon.hp > 0) {
      // the drain plays ABSORB from the healing side (:2386-2390)
      this.animNext("ABSORB", opp.isPlayer);
    }
    if (msgs.length > 0) this.drainNext();
    if (b.mon.hp <= 0) this.onFaint(b);
  }

  /** :2403-2407 queueResidual. */
  queueResidual(b: WildBattler, opp: WildBattler): void {
    if (this.residualAfterMove()) {
      this.act(() => this.residualFor(b, opp));
    }
  }

  /** :2409-2462 endOfTurn. */
  endOfTurn(): void {
    if (this.result) return;
    const sweep = !this.residualAfterMove();
    const playerAlive = this.player.mon.hp > 0;
    const enemyAlive = this.enemy.mon.hp > 0;
    const pairs: [WildBattler, WildBattler, boolean][] = [
      [this.player, this.enemy, enemyAlive],
      [this.enemy, this.player, playerAlive],
    ];
    for (const [b, opp, oppAlive] of pairs) {
      if (sweep && b.mon.hp > 0 && oppAlive) {
        const msgs = statusResidual(b, opp);
        for (const m of msgs) this.sayNext(prefixEnemy(m, b));
        if (msgs.length > 0) this.drainNext();
        if (b.mon.hp <= 0) this.onFaint(b);
      }
      b.skipMove = undefined;
      // CheckNumAttacksLeft's end-of-turn trapping release (:2454-2458)
      if (b.trappingTurns !== undefined && b.trappingTurns <= 0) {
        b.trappingTurns = undefined;
      }
    }
    // tickTokens (:2479-2484): side/field token lists are empty in v1
  }

  // -------------------------------------------------------------------
  // move execution (:3134-3544)
  // -------------------------------------------------------------------

  /** :3134-3138 syncShownStatus — HUD status reveal after the action. */
  syncShownStatus(): void {
    for (const b of [this.player, this.enemy]) {
      if (b) b.shownStatus = b.mon.status ?? null;
    }
  }

  /** :3140-3244 executeAction (wild slice: no AI items/switches, and the
   * recharge/bound/trapping/bide specials are unreachable v1 locks). */
  executeAction(
    user: WildBattler,
    target: WildBattler,
    action: BattleAction | null,
  ): void {
    if (this.result) return;
    if (user.mon.hp <= 0 || target.mon.hp <= 0) return;
    if (!action) return;

    // The SILPH SCOPE's whole mechanical effect. While the RESTLESS SOUL is
    // still disguised (core.asm:6698-6700), the player's mon is too scared to
    // move and the turn is forfeit — so the ghost cannot be beaten, only fled
    // from or ended with a POKE DOLL. The scope does not win the fight, it
    // unveils the MAROWAK so an ordinary one can be had.
    //
    // Nobody moves. ExecuteEnemyMove opens with the same PrintGhostText the
    // player's side does (core.asm:5462-5463), and on the ghost's turn it
    // prints GetOutText and returns: the GHOST never attacks either. What
    // makes standing there costly is only that nothing can end it but
    // running.
    if (this.disguised && user === this.player) {
      this.sayAuto(
        ghostText(this.data, "_ScaredText", "{RAM:wBattleMonNick} is too\nscared to move!")
          .replace("{RAM:wBattleMonNick}", user.name),
      );
      return;
    }
    if (this.disguised && user === this.enemy) {
      this.sayAuto(ghostText(this.data, "_GetOutText", "GHOST: Get out...\nGet out..."));
      return;
    }

    // held-in-place mirror (:3158-3163)
    user.boundTurns =
      target.trappingTurns !== undefined ? Math.max(1, target.trappingTurns) : undefined;

    // The locked specials still run the status gauntlet first
    // (CheckPlayerStatusConditions, core.asm:3328-3583).
    if (action.special === "recharge") {
      // only reaching .HyperBeamCheck consumes the flag (core.asm:3384-
      // 3392): sleep/freeze/held/flinch keep the mon recharging
      if (!this.preRechargeChecks(user, target)) {
        user.mustRecharge = undefined;
        this.sayNext(`${displayName(user)}\nmust recharge!`);
      }
    } else if (action.special === "bound") {
      // the trap ended earlier this turn: the selection is simply lost
      if (target.trappingTurns !== undefined) this.statusInterrupt(user, target);
    } else if (action.special === "trapping") {
      if (!this.statusInterrupt(user, target)) this.continueTrapping(user, target);
    } else if (action.special === "bide") {
      if (!this.statusInterrupt(user, target)) this.continueBide(user, target);
    } else if (!this.statusInterrupt(user, target)) {
      this.performMove(user, target, action, false);
    }
    this.actNext(() => this.syncShownStatus());
    if (this.residualAfterMove()) {
      this.actNext(() => this.residualFor(user, target));
    }
  }

  /** :3326-3356 statusInterrupt — Status.beforeMove + the confusion
   * self-hit. The sleep/confusion onomatopoeia anims (:3250-3268) are text
   * only in v1. */
  statusInterrupt(user: WildBattler, target: WildBattler): boolean {
    const res = statusBeforeMove(user, this.rng);
    for (const m of res.messages) this.sayNext(prefixEnemy(m, user));
    if (res.selfHit) {
      // confusion self-hit (core.asm:3428-3434): 40-power typeless against
      // the mon's own defense, with the OPPONENT's screens applying
      const [dmg] = this.computeDamage(
        user,
        user,
        { id: "CONFUSED", power: 40, type: "NORMAL", accuracy: 100 },
        { rng: this.rng, forceCrit: false, typeless: true, screens: target },
      );
      this.sayNext("It hurt itself in\nits confusion!");
      this.clearVolatiles(user, true);
      this.applyDamage(user, dmg);
      if (user.mon.hp <= 0) this.onFaint(user);
      return true;
    }
    if (!res.canMove) {
      const last = res.messages[res.messages.length - 1];
      if (user.mon.status === "PAR" && last && last.includes("fully paralyzed")) {
        this.clearVolatiles(user, false);
      }
      return true;
    }
    return false;
  }

  /** :3362-3371 clearVolatiles. */
  private clearVolatiles(user: WildBattler, selfHit: boolean): void {
    user.bideTurns = undefined;
    user.bideDamage = undefined;
    user.thrashTurns = undefined;
    user.thrashMove = undefined;
    user.thrashAnnounced = undefined;
    user.charging = undefined;
    user.chargeReady = undefined;
    user.trappingTurns = undefined;
    if (selfHit) {
      user.invulnerable = undefined;
      user.flinched = false;
    }
  }

  /** :3383-3395 primaryEffectFailed. */
  private primaryEffectFailed(msgs: EffectMsgs): boolean {
    if (!msgs || msgs.length === 0) return true;
    if (msgs.failed) return true;
    const m = msgs[0].replace(/\s+$/, "");
    if (m === "But, it failed!" || m === "Nothing happened!") return true;
    if (m.includes("didn't affect")) return true;
    if (m.includes("is unaffected")) return true;
    if (m.includes("protected by MIST")) return true;
    if (m.includes("Already")) return true;
    return false;
  }

  /** :3397-3544 performMove. */
  performMove(
    user: WildBattler,
    target: WildBattler,
    moveInst: MoveSlot & { struggle?: boolean },
    isCalled: boolean,
  ): void {
    const move = this.data.moves[moveInst.id];
    if (!move) {
      console.warn(`unknown move instance ${moveInst.id}`);
      return;
    }
    const record = effectRecord(move.effect);

    // a charge move's second turn (:3469-3473)
    const releasing = user.charging === moveInst && user.chargeReady;
    if (releasing) {
      user.charging = undefined;
      user.chargeReady = undefined;
      user.invulnerable = undefined;
    }

    // PP: not for continuations, struggle, called moves, or (gen1_faithful)
    // enemies — DecrementPP only ever mutates the player side (:3475-3493)
    const isContinuation =
      releasing ||
      (user.thrashTurns !== undefined && user.thrashTurns > 0 && moveInst === user.thrashMove) ||
      moveInst === user.rageMove;
    const enemyUnlimited = !user.isPlayer && this.ruleset.enemyUnlimitedPP;
    if (!isContinuation && !moveInst.struggle && !isCalled && !enemyUnlimited) {
      moveInst.pp = Math.max(0, moveInst.pp - 1);
    }

    this.moveAnimRow = null;
    if (!(user.thrashTurns !== undefined && moveInst === user.thrashMove && user.thrashAnnounced)) {
      this.sayNextAuto(`${displayName(user)}\nused ${move.name}!`);
      if (!(record && record.announceAnim === false)) {
        const row: QueueRow = { anim: move.id, attackerIsPlayer: user.isPlayer };
        this.insertNext(row);
        this.moveAnimRow = row;
      }
    }

    const ctx = makeCtx(this, user, target, move, moveInst, isCalled);

    if (record?.callsMove) {
      const pick = record.callsMove(ctx);
      if (move.id === "MIRROR_MOVE" || !pick) this.cancelMoveAnim();
      if (pick) this.performMove(user, target, { id: pick, pp: 1 }, true);
      return;
    }
    user.lastMove = move.id;

    // charge moves (:3532-3562): the first turn only charges; Fly and Dig
    // go semi-invulnerable
    if (record?.charge && !releasing) {
      this.cancelMoveAnim();
      user.charging = moveInst;
      user.chargeReady = true;
      if (record.charge.invulnerable || move.id === "DIG") user.invulnerable = true;
      let chargeAnim = record.charge.anim;
      if (move.id === "DIG") chargeAnim = "SLIDE_DOWN_ANIM";
      else if (record.charge.enemyAnim && !user.isPlayer) chargeAnim = record.charge.enemyAnim;
      if (chargeAnim) this.animNext(chargeAnim, user.isPlayer);
      const text = CHARGE_TEXT[move.id] ?? "%s\nis charging up!";
      this.sayNext(text.replace("%s", displayName(user)));
      return;
    }

    if (record?.perform) {
      record.perform(ctx);
      return;
    }

    // pure status moves (:3507-3534)
    if (move.power === 0 && record?.kind === "primary" && record.run) {
      if (
        record.accuracyChecked &&
        (target.invulnerable || !this.accuracyRoll(move, user, target))
      ) {
        this.cancelMoveAnim();
        this.sayNext(`${displayName(user)}'s\nattack missed!`);
        return;
      }
      const msgs = record.run(ctx);
      if (this.primaryEffectFailed(msgs)) {
        this.cancelMoveAnim();
      } else if (SLOW_SHAKE_EFFECTS.has(move.effect) && this.moveAnimRow) {
        // types 3 and 6 are the silent ones (a status move's shake)
        this.moveAnimRow.hit = { sfx: null, animType: user.isPlayer ? 6 : 3 };
      }
      for (const m of msgs) this.sayNext(m);
      this.drainNext(); // REST/RECOVER would move the user's bar (:3532)
      return;
    }
    if (move.power === 0 && record?.kind !== "full") {
      // unregistered status effect: the reference's own fallback (:3535-3540)
      if (move.effect) warnUnknown(move.effect);
      this.cancelMoveAnim();
      this.sayNext("But, it failed!");
      return;
    }

    runDamaging(this, ctx, record);
  }

  /** :3347-3386 preRechargeChecks — sleep, freeze, held, flinch each lose
   * the turn WITHOUT consuming the recharge flag. */
  private preRechargeChecks(user: WildBattler, target: WildBattler): boolean {
    if (user.skipMove) {
      user.skipMove = undefined;
      return true;
    }
    const mon = user.mon;
    if (mon.status === "SLP") {
      user.sleepTurns = (user.sleepTurns ?? 1) - 1;
      if (user.sleepTurns <= 0) {
        mon.status = null;
        this.sayNext(`${displayName(user)}\nwoke up!`);
      } else {
        this.sayNext(`${displayName(user)}\nis fast asleep!`);
      }
      return true;
    }
    if (mon.status === "FRZ") {
      this.sayNext(`${displayName(user)}\nis frozen solid!`);
      return true;
    }
    if (target.trappingTurns !== undefined) {
      this.sayNext(`${displayName(user)}\ncan't move!`);
      return true;
    }
    if (user.flinched) {
      user.flinched = false;
      this.sayNext(`${displayName(user)}\nflinched!`);
      return true;
    }
    return false;
  }

  /** :3610-3629 continueTrapping — the same damage again, animation shown. */
  private continueTrapping(user: WildBattler, target: WildBattler): void {
    this.sayNext(`${displayName(user)}'s\nattack continues!`);
    if (user.trapMove) this.animNext(user.trapMove, user.isPlayer);
    // the counter can sit at 0 until endOfTurn clears it, so a slower
    // victim is still held through the attacker's final hit
    user.trappingTurns = (user.trappingTurns ?? 1) - 1;
    this.applyDamage(target, user.trapDamage ?? 1);
    if (target.mon.hp <= 0) this.onFaint(target);
  }

  /** :3631-3651 continueBide — store, then unleash double. */
  private continueBide(user: WildBattler, target: WildBattler): void {
    user.bideTurns = (user.bideTurns ?? 1) - 1;
    if (user.bideTurns > 0) {
      this.sayNext(`${displayName(user)}\nis storing energy!`);
      return;
    }
    this.sayNext(`${displayName(user)}\nunleashed energy!`);
    const dmg = (user.bideDamage ?? 0) * 2;
    user.bideTurns = undefined;
    user.bideDamage = undefined;
    if (dmg <= 0) {
      this.sayNext("But, it failed!");
      return;
    }
    this.animNext("BIDE", user.isPlayer);
    this.applyDamage(target, dmg);
    if (target.mon.hp <= 0) this.onFaint(target);
  }

  /** :3653-3656 selfDestruct. */
  selfDestruct(user: WildBattler): void {
    user.mon.hp = 0;
    this.onFaint(user);
  }

  /** Pay Day's coins (:4675), picked up on a win. */
  payDay = 0;

  get trainerBattle(): boolean {
    return (this as { isTrainer?: boolean }).isTrainer === true;
  }

  /** Teleport / Roar / Whirlwind in the wild: the battle ends here. */
  escape(): void {
    this.result = "run";
    this.afterQueue = "finish";
  }

  // rules bridge (:2210-2246 accuracyRoll/computeDamage/catchAttempt) ----

  accuracyRoll(move: DamageMove, user: WildBattler, target: WildBattler): boolean {
    return damageAccuracyRoll(this.ruleset, move, user, target, this.rng);
  }

  computeDamage(
    user: WildBattler,
    target: WildBattler,
    move: DamageMove,
    opts: {
      rng: Rng;
      explode?: boolean;
      forceCrit?: boolean;
      typeless?: boolean;
      screens?: WildBattler | null;
    },
  ): [number, DamageInfo] {
    return damageCompute(this.ruleset, this.chart, user, target, move, opts);
  }

  inflictStatus(
    target: WildBattler,
    status: string,
    opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
  ): string[] {
    return inflictStatus(this, target, status, opts);
  }

  // -------------------------------------------------------------------
  // damage / faint / exp (:3596-3806)
  // -------------------------------------------------------------------

  /** :3596-3618 applyDamage — returns the amount that counts as dealt. */
  applyDamage(target: WildBattler, dmg: number): number {
    if (target.substituteHP !== undefined) {
      target.substituteHP -= dmg;
      if (target.substituteHP <= 0) {
        target.substituteHP = undefined;
        this.sayNext(`${displayName(target)}'s\nSUBSTITUTE broke!`);
      } else {
        this.sayNext(`The SUBSTITUTE\ntook damage for\n${displayName(target)}!`);
      }
      return dmg;
    }
    const dealt = Math.min(dmg, target.mon.hp);
    target.mon.hp -= dealt;
    if (dealt > 0) this.drainNext(target, target.mon.hp);
    if (target.bideTurns !== undefined) {
      target.bideDamage = (target.bideDamage ?? 0) + dealt;
    }
    if (target.rageMove && dealt > 0) {
      target.stages.attack = Math.min(6, (target.stages.attack ?? 0) + 1);
      this.sayNext(`${displayName(target)}'s\nRAGE is building!`);
    }
    return dealt;
  }

  /** :3624-3689 onFaint. */
  onFaint(battler: WildBattler): void {
    if (battler.faintQueued) return;
    battler.faintQueued = true;
    if (battler.isPlayer) {
      // RemoveFaintedPlayerMon clears the gain-exp flag (:3627-3629)
      this.participants.delete(battler.mon);
    }
    this.actNext(() => {
      battler.fainted = true;
      // SlideDownFaintedMonPic (:3645-3662): the card keeps drawing while
      // it sinks — staging.ts holds it past the `fainted` gate for exactly
      // as long as this animation runs, and the wait row below is already
      // the reference's own FAINT_SLIDE hold, so the slide fills a beat
      // that was being paid anyway. The cry is still a later rung.
      this.startAnim("faint", battler.isPlayer ? SIDE_PLAYER : SIDE_ENEMY);
    });
    this.insertNext({ wait: FAINT_SLIDE });
    if (!battler.isPlayer) {
      // FaintEnemyPokemon .wild_win (:3673-3681, core.asm:792-795): the
      // victory theme starts AS THE SLIDE LANDS, before EnemyMonFaintedText
      // and the exp text — not after the box is dismissed.
      //
      // `.wild_win` is a BRANCH, though: pokered plays it there only when the
      // faint ends the battle. A trainer with mons left keeps the battle
      // theme and pays its victory music in TrainerBattleVictory instead, so
      // this asks whether the battle is actually over.
      const kind = this.victoryMusicKind();
      if (kind) this.actNext(() => this.audioCues.push(`music:victory:${kind}`));
    }
    this.sayNext(`${displayName(battler)}\nfainted!`);
    if (battler.isPlayer) {
      this.act(() => this.playerMonFainted());
    } else {
      this.act(() => this.enemyMonFainted());
    }
  }

  /** :3694-3806 awardExp — participant split, EXP.ALL passes, level-ups,
   * stat boxes, learnset checks. */
  awardExp(): void {
    let participants = 0;
    const alive: PartyMon[] = [];
    for (const mon of this.save.party) {
      if (this.participants.has(mon)) {
        participants += 1;
        if (mon.hp > 0) alive.push(mon);
      }
    }
    if (participants === 0 && this.player.mon.hp > 0) {
      participants = 1;
      alive.length = 0;
      alive.push(this.player.mon);
    }
    const applyShare = (mon: PartyMon, split: number, announce: true | "expAll") => {
      const [levels, gained] = expApply(
        this.data,
        mon,
        this.enemy.def,
        this.enemy.mon.level,
        false,
        split,
        mon.traded,
      );
      if (levels.length > 0) this.leveledUp.add(mon);
      const name = mon.nickname ?? this.data.pokemon[mon.species].name;
      if (announce === "expAll") {
        this.sayNext(`${name} gained\nwith EXP.ALL,\v${gained} EXP. Points!`);
      } else if (mon.traded) {
        this.sayNext(`${name} gained\na boosted\v${gained} EXP. Points!`);
      } else {
        this.sayNext(`${name} gained\n${gained} EXP. Points!`);
      }
      for (const lv of levels) {
        this.sayNext(`${name} grew\nto level ${lv}!`);
        this.statBoxNext(mon);
        // the HP bar animates UP to the level-up heal (:3755-3765, #224)
        if (mon === this.player.mon) this.drainNext();
        for (const moveId of movesLearnedAt(this.data.pokemon[mon.species], lv)) {
          this.learnMove(mon, moveId);
        }
      }
    };
    // vanillaExpAward (:3776-3797)
    const expAll = (this.save.inventory.EXP_ALL ?? 0) > 0;
    for (const mon of alive) {
      applyShare(mon, participants * (expAll ? 2 : 1), true);
    }
    if (expAll) {
      for (const mon of this.save.party) {
        if (mon.hp > 0) {
          applyShare(mon, Math.max(1, participants) * this.save.party.length * 2, "expAll");
        }
      }
    }
    this.participants = new Set();
  }

  /** :3993-4012 learnMove — auto when a slot is free, otherwise the
   * replace-move prompt (MoveLearnMenu). A full moveset parks the queue on
   * the "forget" phase the way openParty parks it on "party"; updateForget
   * resumes it either way. */
  learnMove(mon: PartyMon, moveId: string): void {
    const mdef = this.data.moves[moveId];
    if (!mdef) return;
    if (mon.moves.some((mv) => mv.id === moveId)) return;
    const name = mon.nickname ?? this.data.pokemon[mon.species].name;
    if (mon.moves.length < 4) {
      mon.moves.push({ id: moveId, pp: mdef.pp });
      this.sayNext(`${name} learned\n${mdef.name}!`);
      return;
    }
    this.sayNext(`${name} is trying to\nlearn ${mdef.name}!`);
    this.sayNext(`But ${name} can't\nlearn more than\f4 moves!`);
    this.actNext(() => {
      this.learnPending = { mon, moveId };
      this.forgetIndex = 0;
      this.phase = "forget";
    });
  }

  /** The move list the replace prompt is showing, or null. */
  forgetView(): { name: string; moves: string[]; index: number; learning: string } | null {
    const p = this.learnPending;
    if (this.phase !== "forget" || !p) return null;
    return {
      name: p.mon.nickname ?? this.data.pokemon[p.mon.species].name,
      moves: p.mon.moves.map((mv) => this.data.moves[mv.id]?.name ?? mv.id),
      index: this.forgetIndex,
      learning: this.data.moves[p.moveId]?.name ?? p.moveId,
    };
  }

  /** Move slots + a trailing cancel row. */
  private updateForget(input: BattleInput): void {
    const p = this.learnPending;
    if (!p) { this.phase = "messages"; return; }
    const rows = p.mon.moves.length + 1; // + cancel
    const step = listStep(input);
    if (step) {
      this.forgetIndex = (this.forgetIndex + step + rows) % rows;
      return;
    }
    const name = p.mon.nickname ?? this.data.pokemon[p.mon.species].name;
    const learning = this.data.moves[p.moveId]?.name ?? p.moveId;
    const decline = (): void => {
      this.learnPending = null;
      this.say(`${name} did not learn\n${learning}!`);
      this.phase = "messages";
    };
    if (input.wasPressed("b") || (input.wasPressed("a") && this.forgetIndex >= rows - 1)) {
      decline();
      return;
    }
    if (!input.wasPressed("a")) return;
    const slot = p.mon.moves[this.forgetIndex];
    if (!slot) { decline(); return; }
    // Gen 1 will not let an HM move be forgotten (it is the only way off
    // some maps, and there is no Move Deleter until Gen 2).
    if (this.hmMoves().has(slot.id)) {
      this.say("HM moves can't be\nforgotten now!");
      this.phase = "messages";
      return;
    }
    const forgotten = this.data.moves[slot.id]?.name ?? slot.id;
    const mdef = this.data.moves[p.moveId];
    p.mon.moves[this.forgetIndex] = { id: p.moveId, pp: mdef?.pp ?? 0 };
    this.learnPending = null;
    this.say(`1, 2 and... Poof!\f${name} forgot\n${forgotten}!\fAnd...`);
    this.sayNext(`${name} learned\n${learning}!`);
    this.phase = "messages";
  }

  /** Moves taught by an HM, by item definition rather than a hardcoded list. */
  private hmMoves(): Set<string> {
    if (!this.hmCache) {
      this.hmCache = new Set<string>();
      for (const it of Object.values(this.data.items ?? {})) {
        const m = (it as { machine?: { kind?: string; move?: string } }).machine;
        if (m?.kind === "HM" && m.move) this.hmCache.add(m.move);
      }
    }
    return this.hmCache;
  }

  /** Swap the enemy battler (trainer send-out; makeBattler is module-local). */
  swapEnemy(mon: PartyMon): void {
    this.enemy = makeBattler(this.data, mon, false);
    // EnemySendOutFirstMon (core.asm:1314-1315): frees the player's trap
    this.player.trappingTurns = undefined;
    this.player.trapMove = undefined;
    this.player.trapDamage = undefined;
  }

  /** :3808-3990 enemyMonFainted, wild slice: exp then the win. */
  enemyMonFainted(): void {
    this.awardExp();
    this.result = "win";
    this.afterQueue = "finish";
  }

  /** :4030-4092 playerMonFainted — blackout, or the wild "Use next
   * POKéMON?" dialogue whose NO branch is a run check on party slot 1. */
  playerMonFainted(): void {
    const nextMon = firstHealthy(this.save.party);
    if (!nextMon && this.result !== "lose") {
      // HandlePlayerBlackOut (:4052-4064, #292): darken, then the lines
      this.blackedOut = true;
      this.sayNext(`${this.save.player.name} is out of\nuseable POKéMON!`);
      this.sayNext(`${this.save.player.name} blacked\nout!`);
      this.result = "lose";
      this.afterQueue = "finish";
      return;
    }
    if (this.result) return; // double faint: the battle is decided (:4069)
    this.sayChoice("Use next POKéMON?", (yes) => {
      if (yes) return; // the menu-phase guard opens the party menu (:1856)
      const pSpd = this.save.party[0]?.stats.speed ?? 0;
      if (this.runRoll(pSpd, effectiveSpeed(this.enemy))) {
        this.say("Got away safely!");
        this.result = "run";
        this.afterQueue = "finish";
      } else {
        this.say("Can't escape!");
      }
    });
  }

  // -------------------------------------------------------------------
  // run (:4253-4313)
  // -------------------------------------------------------------------

  /** :4265-4279 runRollVanilla — TryRunningFromBattle. */
  runRoll(pSpd: number, eSpd: number): boolean {
    this.runAttempts += 1;
    if (pSpd >= eSpd) return true;
    const b = Math.floor(eSpd / 4) % 256;
    if (b === 0) return true;
    let x = Math.floor((pSpd * 32) / b);
    x += 30 * (this.runAttempts - 1);
    return x >= 256 || this.rng.byte() <= x;
  }

  /** :4282-4313 tryRun. */
  tryRun(): void {
    this.phase = "messages";
    this.afterQueue = "menu";
    const escaped = this.runRoll(effectiveSpeed(this.player), effectiveSpeed(this.enemy));
    if (escaped) {
      this.say("Got away safely!");
      this.result = "run";
      this.afterQueue = "finish";
    } else {
      this.say("Can't escape!");
      this.act(() => {
        this.executeAction(this.enemy, this.player, this.enemyAction());
      });
      // a failed escape loses the turn but the residual still ticks (:4308)
      this.queueResidual(this.player, this.enemy);
      this.act(() => this.endOfTurn());
    }
  }

  // -------------------------------------------------------------------
  // items / catching (:4315-4575)
  // -------------------------------------------------------------------

  /** :4315-4321 openItems, narrowed to balls (v1: the bag is ball-only). */
  openItems(): void {
    this.itemList = Object.keys(this.save.inventory).filter((id) => {
      if ((this.save.inventory[id] ?? 0) <= 0) return false;
      const def = this.data.items?.[id];
      return def?.ball !== undefined || id.endsWith("_BALL");
    });
    if (this.itemList.length === 0) {
      // v1 stand-in for an empty battle bag; the reference opens the full
      // BagMenu screen (:4318)
      this.say("There are no\nitems to use!");
      this.phase = "messages";
      this.afterQueue = "menu";
      return;
    }
    this.itemIndex = Math.min(this.itemIndex, this.itemList.length - 1);
    this.phase = "item";
  }

  private updateItems(input: BattleInput): void {
    const step = listStep(input);
    if (step) {
      this.itemIndex = Math.max(
        0, Math.min(this.itemList.length - 1, this.itemIndex + step),
      );
    } else if (input.wasPressed("b")) {
      this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const ball = this.itemList[this.itemIndex];
      // UseBagItem consumes the ball (item_effects.asm .done)
      this.save.inventory[ball] = (this.save.inventory[ball] ?? 1) - 1;
      if (this.save.inventory[ball] <= 0) delete this.save.inventory[ball];
      this.phase = "messages";
      this.afterQueue = "menu";
      this.throwBall(ball);
    }
  }

  /** :4342-4352 ballMissMessage — wobble text by shake count. */
  ballMissMessage(shakes: number): string {
    if (shakes === 0) return "You missed the\nPOKéMON!";
    if (shakes === 1) return "Darn! The POKéMON\nbroke free!";
    if (shakes === 2) return "Aww! It appeared\nto be caught!";
    return "Shoot! It was so\nclose too!";
  }

  /** :4447-4464 ballChain — the TossBallAnimation row chain; v1 rows pace
   * the queue (MOVE_ANIM_PRE each) but draw nothing. */
  protected ballChain(caught: boolean, shakes: number, ball: string): void {
    this.animNext("TOSS_ANIM", true, undefined, ball);
    this.animNext("POOF_ANIM", true);
    if (!caught && shakes === 0) return;
    this.animNext("HIDEPIC_ANIM", true);
    this.animNext("SHAKE_ANIM", true, shakes);
    if (!caught) {
      this.animNext("POOF_ANIM", true);
      this.animNext("SHOWPIC_ANIM", true);
    }
  }

  /** :4484-4575 throwBall, wild branch (trainer block-ball is out). */
  throwBall(ball: string): void {
    const itemName = this.data.items?.[ball]?.name ?? ball;
    this.sayAuto(`${this.save.player.name} used\n${itemName}!`);
    // item_effects.asm:166-175 ItemUseBall .notOldManBattle: on
    // POKEMON_TOWER_6F the RESTLESS SOUL dodges the ball whether or not the
    // SILPH SCOPE revealed it, so the dodge rides the battle rather than the
    // disguise. The turn still passes -- the ghost gets its move.
    if (this.noCatch) {
      this.act(() => {
        this.lastBall = ball;
        // ItemUseBallText00 — the dodge line, the same one a master-ball-proof
        // encounter prints.
        this.sayNext(ghostText(this.data, "_ItemUseBallText00",
          "It dodged the\nthrown BALL!\fThis POKéMON\ncan't be caught!"));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      });
      return;
    }
    this.act(() => {
      this.lastBall = ball;
      const [caught, shakes] = catchAttempt(ball, this.enemy.mon, this.enemy.def, this.rng);
      // ItemUseBall's 20-frame beat before the toss chain (:4551-4553)
      this.insertNext({ wait: 20 });
      this.ballChain(caught, shakes, ball);
      if (caught) {
        this.sayNext(`All right!\n${this.enemy.name} was\ncaught!`);
        this.act(() => this.storeCaughtMon());
      } else {
        this.sayNext(this.ballMissMessage(shakes));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      }
    });
  }

  /**
   * The species this catch added to the dex for the FIRST time, else null.
   * The shell reads it after the battle closes and shows the entry
   * (item_effects.asm: _ItemUseBallText06 then `predef ShowPokedexData`).
   * Cleared by whoever consumes it.
   */
  caughtNewSpecies: string | null = null;

  /** :4387-4440 storeCaughtMon. DEVIATIONS (v1): no nickname prompt, and with
   * a full party the mon is NOT stored — the PC transfer text prints and the
   * mon is lost (the box system is a later rung; item_effects.asm:518-566 is
   * the reference flow). */
  storeCaughtMon(): void {
    // BattleState.lua:4451/4465 storeCaughtMon: a caught mon is marked owned
    // (+seen) whether or not it fits the party — the mark precedes the PC
    // transfer, so a full-party catch still fills the dex. Whether the mark
    // is NEW has to be read before it is made.
    const species = this.enemy.mon.species;
    if (!this.save.pokedex?.owned?.[species]) this.caughtNewSpecies = species;
    markOwned(this.save, species);
    if (partyAdd(this.save.party, this.enemy.mon)) {
      // joined the party
    } else {
      this.sayNext(`${this.enemy.name} was\ntransferred to\nsomeone's PC!`);
    }
    this.result = "caught";
    this.afterQueue = "finish";
  }

  // -------------------------------------------------------------------
  // party / switching (:2334-2365, :4097-4135, :4577-4594)
  // -------------------------------------------------------------------

  /** :4577-4594 openParty / :4097-4101 openReplacementMenu (forced). */
  openParty(forced: boolean): void {
    this.partyForced = forced;
    this.partyIndex = 0;
    this.phase = "party";
  }

  private updateParty(input: BattleInput): void {
    const party = this.save.party;
    if (pressedDir(input)) {
      // Two mons to a row on the gear, same as the moves.
      this.partyIndex = gridStep(input, this.partyIndex, GEAR_GRID_COLS, party.length);
    } else if (input.wasPressed("b")) {
      // ChooseNextMon loops until a healthy pick (:1856-1865): B only
      // backs out of a VOLUNTARY open
      if (!this.partyForced) this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const mon = party[this.partyIndex];
      if (!mon) return;
      if (this.partyForced) {
        if (mon.hp <= 0) {
          this.say("There's no will\nto fight!");
          this.phase = "messages";
          this.afterQueue = "menu"; // the menu guard reopens the menu
          return;
        }
        this.replaceFainted(mon);
      } else if (mon === this.player.mon) {
        this.say(`${this.player.name} is\nalready out!`);
        this.phase = "messages";
        this.afterQueue = "menu";
      } else if (mon.hp <= 0) {
        this.say("There's no will\nto fight!");
        this.phase = "messages";
        this.afterQueue = "menu";
      } else {
        this.resolveSwitch(mon);
      }
    }
  }

  /** :4106-4134 openReplacementMenu onSwitch — send out with NO free enemy
   * move (ChooseNextMon). */
  private replaceFainted(mon: PartyMon): void {
    this.player = makeBattler(this.data, mon, true, this.save);
    this.markParticipant();
    this.sendOutMonCursors();
    this.nextInsert = 0;
    this.sendingOut = true;
    this.sayNext(this.sendOutText(this.player.name));
    this.animNext("POOF_ANIM", false);
    this.actNext(() => {
      this.sendingOut = false;
    });
    this.phase = "messages";
    this.afterQueue = "menu";
  }

  /** :2334-2365 resolveSwitch — voluntary switch; the enemy gets a free
   * move. */
  resolveSwitch(next: PartyMon): void {
    this.phase = "messages";
    this.afterQueue = "menu";
    this.act(() => {
      this.player = makeBattler(this.data, next, true, this.save);
      // SendOutMon clears the FOE's trapping bit (:2341-2343)
      this.enemy.trappingTurns = undefined;
      this.enemy.trapMove = undefined;
      this.enemy.trapDamage = undefined;
      this.markParticipant();
      this.sendOutMonCursors();
      this.sendingOut = true;
      this.sayNext(this.sendOutText(this.player.name));
      this.animNext("POOF_ANIM", false);
      this.actNext(() => {
        this.sendingOut = false;
      });
    });
    this.act(() => {
      this.executeAction(this.enemy, this.player, this.enemyAction());
    });
    this.act(() => this.endOfTurn());
  }

  /** :1665-1668 sendOutMonCursors — every player send-out resets both. */
  private sendOutMonCursors(): void {
    this.menuIndex = 1;
    this.moveIndex = 1;
  }

  // -------------------------------------------------------------------
  // finish (:4610-4665)
  // -------------------------------------------------------------------

  finish(): void {
    // :4675-4682 — Pay Day's coins, picked up only on a win
    if (this.payDay > 0 && this.result === "win") {
      const save = this.save as BattleSave & { money?: number };
      if (typeof save.money === "number") save.money += this.payDay;
      this.say(`${this.save.player.name} picked up\n$${this.payDay}!`);
      this.payDay = 0;
      this.afterQueue = "finish";
      this.phase = "messages";
      return;
    }
    // the no-healthy-party invariant (:4629-4634)
    if (this.result !== "lose" && !firstHealthy(this.save.party)) {
      console.warn(`battle finished ${this.result} with no healthy party; forcing blackout`);
      this.result = "lose";
    }
    // :4647 — leaving the battle brings the map theme back HERE, at teardown,
    // not after the POST_BATTLE_RETURN hold the shell still owes
    this.audioCues.push("music:restore");
    this.finished = this.result ?? "run";
  }

  /** The integer HP the HUD shows (:1006-1010 shownHP). */
  shownHPInt(b: WildBattler): number {
    const shown = b.shownHP ?? b.mon.hp;
    return shown > b.mon.hp ? Math.ceil(shown) : Math.floor(shown);
  }
}
