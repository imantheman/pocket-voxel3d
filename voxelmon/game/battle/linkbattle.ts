// A COLOSSEUM battle: the same engine, with the other console picking the
// enemy's moves.
//
// The ROM runs the whole fight on BOTH Game Boys at once and keeps them in
// step by exchanging two things and nothing else: a shared pool of random
// numbers at the start, and one choice per turn. Neither side sends damage,
// or HP, or who won -- both simulate it and arrive at the same answer. That
// is what this does.
//
// Two pieces make it hold:
//
//   The seed. Each console rolls half and they are XORed, so neither side
//   decides the luck alone and neither has to trust the other to have
//   rolled fairly. Both then run the identical stream.
//
//   The draw ORDER. The stream only helps if both consoles pull from it in
//   the same sequence, and the two are mirror images -- my player is your
//   enemy. It works because the engine resolves a turn in SPEED order, and
//   speed is a property of the mons rather than of which side is holding
//   the console: both agree who moves first, so both draw in the same
//   order. A speed TIE is the one place that breaks: the engine flips a
//   coin for "the player first", and the player is a different mon on each
//   console, so seat 1 reads the same flip the other way round (mirror).
//   That is the assumption the whole thing rests on, so there is a test
//   that runs two of these against each other -- with identical mons, so
//   every turn is a tie -- and checks they stay identical rather than
//   taking it on trust.
//
// A "choice" is more than a move. A switch is a turn (BattleAction.switchTo)
// and crosses like one; the mon sent out after a faint is the fainted
// side's pick, sent as a REPLACE, and the other console holds its menu
// until it has arrived -- it must not guess, because a guess is a fork.
// Items are refused: their effects would have to be replayed on the other
// console too, and the fight is honest without them.

import { TrainerBattle } from "./trainer.ts";
import type { BattleAction, BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { firstHealthy, type PartyMon } from "./mon.ts";

/** Just the part of the session a battle needs. */
export interface BattleLink {
  sendAction(a: unknown): void;
  takeAction(): unknown | null;
  peekAction(): unknown | null;
  /** The other console is gone. */
  closed(): boolean;
}

/** What crosses for a replacement after a faint. */
const REPLACE = "REPLACE";

export class LinkBattle extends TrainerBattle {
  /** Their choice for the turn being resolved. */
  private wireAction: BattleAction | null = null;
  /** Mine, held while theirs is still in the air. */
  private pendingMine: BattleAction | null = null;
  /** Their mon fainted; the one they send out next is theirs to pick. */
  private awaitingReplacement = false;
  /**
   * The last choice the other player actually made. Kept after the turn is
   * over -- `wireAction` is cleared so the next turn cannot reuse it, which
   * leaves nothing to show a spectator or to check in a test.
   */
  lastPeerAction: BattleAction | null = null;

  /** Both consoles roll the same copy (MimicEffect's link arm). */
  protected override mimicByMenu(): boolean {
    return false;
  }

  constructor(
    data: VoxelmonData,
    save: BattleSave,
    rng: Rng,
    peerName: string,
    peerParty: PartyMon[],
    private link: BattleLink,
    /** True on seat 1: this console reads every speed-tie flip inverted. */
    private mirror = false,
  ) {
    super(data, save, rng, "", 1, peerName, peerParty);
  }

  protected override mirrorTie(): boolean {
    return this.mirror;
  }

  /** On a tie the two consoles' logs must disagree here: one "me", one "them". */
  protected override onTurnOrder(playerFirst: boolean): void {
    this.trace(`order: ${playerFirst ? "me" : "them"} first (mirror=${this.mirror})`);
  }

  /** No experience from a link battle (the ROM's rule), and so no
   * level-ups and nothing to evolve on the way out. */
  override awardExp(): void {}

  /** The host log, when there is one (voxel_shim.c); silent under test. */
  private trace(msg: string): void {
    if ((globalThis as { voxel?: unknown }).voxel) console.log(`[pv] link: battle ${msg}`);
  }

  /** True while this console is holding for the other one's choice. */
  waitingForPeer(): boolean {
    return this.pendingMine !== null;
  }

  /** True while the other player is choosing what to send out. */
  waitingForReplacement(): boolean {
    return this.awaitingReplacement;
  }

  /**
   * The enemy's move is whatever the other player picked. Never the AI:
   * a link battle has no AI in it, and Struggle is the only thing left if
   * a choice somehow fails to arrive.
   */
  override enemyAction(): BattleAction {
    return this.wireAction ?? { id: "STRUGGLE", pp: 1, struggle: true };
  }

  /**
   * Hold the turn until both choices are in.
   *
   * The engine calls this the moment the player picks, from four places in
   * its own menu handling. All four are intercepted: the choice goes out,
   * nothing resolves, and update() finishes the turn once the other
   * console's choice lands. The move menu stays up meanwhile, which is
   * what the ROM does too -- it waits with the menu on screen.
   */
  override resolveTurn(mine: BattleAction): void {
    if (this.wireAction) {
      super.resolveTurn(mine);
      return;
    }
    this.pendingMine = mine;
    this.link.sendAction(mine);
  }

  /** A switch is a turn: it crosses, and the other side's move follows it. */
  override resolveSwitch(next: PartyMon): void {
    const slot = this.save.party.indexOf(next);
    if (slot < 0) return;
    this.resolveTurn({ id: "SWITCH", pp: 0, switchTo: slot });
  }

  /**
   * Their mon fainted. What comes out next is their pick, not the next in
   * their party: hold until it arrives (update). With nothing left on
   * their bench the fight is decided here, on both consoles alike.
   */
  override enemyMonFainted(): void {
    if (this.enemyBench().length === 0) {
      this.result = "win";
      this.afterQueue = "finish";
      return;
    }
    this.awaitingReplacement = true;
  }

  /**
   * Mine fainted. No "use next?" -- there is no running from a link
   * battle -- so the forced party menu opens by itself (the menu guard),
   * or with nothing left it is lost, in the ROM's words.
   */
  override playerMonFainted(): void {
    if (this.result) return;
    if (!firstHealthy(this.save.party)) {
      this.sayNext(`${this.save.player.name} lost to\n${this.trainerName}!`);
      this.result = "lose";
      this.afterQueue = "finish";
    }
  }

  /** My pick after a faint goes out as a REPLACE, then happens here. */
  protected override replaceFainted(mon: PartyMon): void {
    const slot = this.save.party.indexOf(mon);
    this.trace(`my replacement: slot ${slot} (${mon.species})`);
    this.link.sendAction({ id: REPLACE, pp: 0, switchTo: slot });
    super.replaceFainted(mon);
  }

  /** Not in a link battle: the other console would have to replay it. */
  override openItems(): void {
    this.say("Items can't be\nused here!");
    this.phase = "messages";
    this.afterQueue = "menu";
  }

  override update(input: Parameters<TrainerBattle["update"]>[0]): void {
    // The other console has gone -- walked out, switched off, out of
    // range. Nothing more will come from it, so the fight ends here, in
    // the ROM's words, and nobody wins it. Checked every frame rather than
    // only while waiting on a choice: a player left at the menu would
    // otherwise pick a move into the void first.
    if (this.result === null && this.link.closed()) {
      this.trace("the link closed mid-battle");
      this.pendingMine = null;
      this.awaitingReplacement = false;
      this.say("The link was\ncanceled.");
      this.result = "run";
      this.phase = "messages";
      this.afterQueue = "finish";
      return;
    }
    if (this.awaitingReplacement) {
      const head = this.link.peekAction() as { id?: string; switchTo?: number } | null;
      if (head && head.id === REPLACE && typeof head.switchTo === "number") {
        this.link.takeAction();
        this.awaitingReplacement = false;
        this.trace(`their replacement: slot ${head.switchTo}`);
        if (this.phase === "menu") {
          this.phase = "messages";
          this.afterQueue = "menu";
        }
        this.enemySwitch(head.switchTo);
      } else if (this.phase === "menu" && this.player.mon.hp > 0) {
        return; // the menu waits for their pick
      }
    }
    const mine = this.pendingMine;
    if (mine) {
      const theirs = this.link.takeAction() as BattleAction | null;
      if (!theirs || typeof theirs.id !== "string") return; // still waiting
      this.wireAction = theirs;
      this.lastPeerAction = theirs;
      this.pendingMine = null;
      // One line per turn in the host log, on both consoles: the two logs
      // must read as mirror images, HP for HP, or the fight has forked.
      this.trace(`turn ${this.turnCount + 1}: ${this.player.mon.species} ${this.player.mon.hp}` +
        ` vs ${this.enemy.mon.species} ${this.enemy.mon.hp}; mine=${mine.id}` +
        `${mine.switchTo !== undefined ? "#" + mine.switchTo : ""} theirs=${theirs.id}` +
        `${theirs.switchTo !== undefined ? "#" + theirs.switchTo : ""}`);
      super.resolveTurn(mine);
      this.wireAction = null;
      return;
    }
    super.update(input);
  }
}
