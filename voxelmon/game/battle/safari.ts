// SAFARI ZONE battles over the wild-battle engine (engine/battle/core.asm's
// safari sections + engine/battle/safari_zone.asm, via gen1recomp
// BattleState:makeSafari). The player's mon never acts and is never shown:
// the menu is BALL / BAIT / ROCK / RUN, and the wild mon's own turn is a
// chance to bolt.
//
// Two factors drive it, and they are mutually exclusive — each action zeroes
// the other:
//
//   bait   halves the working catch rate, and quarters the flee chance while
//          it lasts. Set by BAIT to a random 1-5.
//   escape doubles the working catch rate, and doubles the flee chance. Set
//          by ROCK to a random 1-5, and when it decays to zero the catch rate
//          snaps back to the species' base.
//
// The working rate is the battle's, not the species': ItemUseBait/ItemUseRock
// write wSafariCatchFactor, which is what the ball roll reads.

import { WildBattle, type BattleInput, type BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { attempt as catchAttempt } from "../rules/catching.ts";
import type { SafariState } from "../world/safari.ts";

/** The action grid, in menuIndex order (1..4). */
export const SAFARI_ACTIONS = ["BALL", "BAIT", "ROCK", "RUN"] as const;
export type SafariAction = "ball" | "bait" | "rock" | "run";

export class SafariBattle extends WildBattle {
  readonly isSafari = true;
  /** The live game — balls are spent straight out of it. */
  readonly safari: SafariState;
  /** wSafariCatchFactor: the rate BAIT/ROCK move, not the species' own. */
  catchFactor: number;
  baitFactor = 0;
  escapeFactor = 0;
  /** Set when the game ended in here (out of balls) so the shell can call it. */
  outOfBalls = false;

  constructor(
    data: VoxelmonData,
    save: BattleSave,
    rng: Rng,
    species: string,
    level: number,
    safari: SafariState,
  ) {
    super(data, save, rng, species, level);
    this.safari = safari;
    this.catchFactor = this.enemy.def.catchRate;
  }

  /** No mon is sent out, so no player card and no player HUD. */
  protected override sendsPlayerMon(): boolean {
    return false;
  }

  /**
   * DisplayBattleMenu's safari branch. A 2x2 grid like the ordinary menu, so
   * the d-pad reads the same; A commits.
   */
  protected override safariMenu(input: BattleInput): boolean {
    if (this.safari.balls <= 0) {
      this.safariOutOfBalls();
      return true;
    }
    let col = (this.menuIndex - 1) % 2;
    let row = Math.floor((this.menuIndex - 1) / 2);
    if (input.wasPressed("left")) col = Math.max(0, col - 1);
    else if (input.wasPressed("right")) col = Math.min(1, col + 1);
    else if (input.wasPressed("up")) row = Math.max(0, row - 1);
    else if (input.wasPressed("down")) row = Math.min(1, row + 1);
    this.menuIndex = row * 2 + col + 1;
    if (input.wasPressed("a")) {
      this.safariAction((["ball", "bait", "rock", "run"] as const)[this.menuIndex - 1]!);
    }
    return true;
  }

  /** The ball roll, against the WORKING rate rather than the species'. */
  private safariCatch(): [boolean, number] {
    return catchAttempt(
      "SAFARI_BALL",
      this.enemy.mon,
      this.enemy.def,
      this.rng,
      this.catchFactor,
      { statuses: (this.data as { statuses?: never }).statuses },
    );
  }

  /**
   * The menu choice. `phase`/`afterQueue` are set the way every other action
   * path sets them, so the queue drains back to the menu unless the battle
   * ends.
   */
  safariAction(choice: SafariAction): void {
    this.phase = "messages";
    this.afterQueue = "menu";
    const name = this.save.player.name;

    if (choice === "run") {
      this.audioCues.push("sfx:Run");
      this.say("Got away safely!");
      this.result = "run";
      this.afterQueue = "finish";
      return;
    }

    if (choice === "ball") {
      this.safari.balls -= 1;
      this.sayAuto(`${name} used\nSAFARI BALL!`);
      this.act(() => this.throwSafariBall());
      return;
    }

    if (choice === "bait") {
      this.say(`${name} threw\nsome BAIT.`);
      this.catchFactor = Math.floor(this.catchFactor / 2);
      this.baitFactor = Math.min(255, this.baitFactor + this.rollFactor());
      this.escapeFactor = 0;
    } else {
      this.say(`${name} threw a\nROCK.`);
      this.catchFactor = Math.min(255, this.catchFactor * 2);
      this.escapeFactor = Math.min(255, this.escapeFactor + this.rollFactor());
      this.baitFactor = 0;
    }
    this.act(() => this.safariEnemyTurn());
  }

  /** ItemUseBait/ItemUseRock's `rand(1,5)` bump. */
  private rollFactor(): number {
    return 1 + (this.rng.byte() % 5);
  }

  private throwSafariBall(): void {
    this.audioCues.push("sfx:Ball_Toss");
    const [caught, shakes] = this.safariCatch();
    this.ballChain(caught, shakes, "SAFARI_BALL");
    if (caught) {
      this.sayNext(`All right!\n${this.enemy.name} was\ncaught!`);
      this.act(() => this.storeCaughtMon());
      return;
    }
    this.sayNext(this.ballMissMessage(shakes));
    this.act(() => this.safariEnemyTurn());
  }

  /**
   * safari_zone.asm's per-turn decay, then the flee check
   * (core.asm: b = 2*speed, quartered while eating, doubled while angry; the
   * mon leaves outright when speed > 127, else on rand(0,255) < b).
   */
  private safariEnemyTurn(): void {
    if (this.baitFactor > 0) {
      this.baitFactor -= 1;
      this.sayNext(`Wild ${this.enemy.name}\nis eating!`);
    } else if (this.escapeFactor > 0) {
      this.escapeFactor -= 1;
      // PrintSafariZoneBattleText: the rate snaps back when anger runs out
      if (this.escapeFactor === 0) this.catchFactor = this.enemy.def.catchRate;
      this.sayNext(`Wild ${this.enemy.name}\nis angry!`);
    }
    this.act(() => this.fleeCheck());
  }

  private fleeCheck(): void {
    const speed = this.enemy.mon.stats.speed % 256;
    let fled = speed > 127;
    if (!fled) {
      let b = (speed * 2) % 256;
      if (this.baitFactor > 0) b = Math.floor(b / 4);
      if (this.escapeFactor > 0) b = Math.min(255, b * 2);
      fled = this.rng.byte() < b;
    }
    if (!fled) return;
    this.sayNext(`Wild ${this.enemy.name}\nran!`);
    this.audioCues.push("sfx:Run");
    this.result = "run";
    this.afterQueue = "finish";
  }

  /**
   * Out of balls: the PA ends the GAME, not just the battle
   * (DisplayBattleMenu's safari branch). The shell reads `outOfBalls` when
   * the battle closes and runs the game-over there, since the warp home
   * belongs to the overworld.
   */
  safariOutOfBalls(): void {
    this.outOfBalls = true;
    this.say("PA: You're out of\nSAFARI BALLs!");
    this.phase = "messages";
    this.result = "run";
    this.afterQueue = "finish";
  }
}
