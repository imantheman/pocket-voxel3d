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
//   order. That is the assumption the whole thing rests on, so there is a
//   test that runs two of these against each other and checks they stay
//   identical rather than taking it on trust.

import { TrainerBattle } from "./trainer.ts";
import type { BattleAction, BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import type { PartyMon } from "./mon.ts";

/** Just the part of the session a battle needs. */
export interface BattleLink {
  sendAction(a: unknown): void;
  takeAction(): unknown | null;
}

export class LinkBattle extends TrainerBattle {
  /** Their choice for the turn being resolved. */
  private wireAction: BattleAction | null = null;
  /** Mine, held while theirs is still in the air. */
  private pendingMine: BattleAction | null = null;
  /**
   * The last choice the other player actually made. Kept after the turn is
   * over -- `wireAction` is cleared so the next turn cannot reuse it, which
   * leaves nothing to show a spectator or to check in a test.
   */
  lastPeerAction: BattleAction | null = null;

  constructor(
    data: VoxelmonData,
    save: BattleSave,
    rng: Rng,
    peerName: string,
    peerParty: PartyMon[],
    private link: BattleLink,
  ) {
    super(data, save, rng, "", 1, peerName, peerParty);
  }

  /** True while this console is holding for the other one's choice. */
  waitingForPeer(): boolean {
    return this.pendingMine !== null;
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

  override update(input: Parameters<TrainerBattle["update"]>[0]): void {
    const mine = this.pendingMine;
    if (mine) {
      const theirs = this.link.takeAction() as BattleAction | null;
      if (!theirs || typeof theirs.id !== "string") return; // still waiting
      this.wireAction = theirs;
      this.lastPeerAction = theirs;
      this.pendingMine = null;
      super.resolveTurn(mine);
      this.wireAction = null;
      return;
    }
    super.update(input);
  }
}
