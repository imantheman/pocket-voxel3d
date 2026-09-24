// The DIPLOMA (engine/events/diploma.asm DisplayDiploma), the one thing a
// completed POKéDEX is worth.
//
// The GAME FREAK development floor at the top of the CELADON MANSION is where
// it is handed over: the game designer asks how the dex is coming, and with
// all 150 owned — the ROM counts NUM_POKEMON - 1, discounting MEW, which no
// honest save can hold — he prints this page instead of his usual line.
//
// Nothing to choose and nothing to get wrong: it holds until a button, the
// way the Hall of Fame roll does, and the script that opened it resumes
// after. The strings are not in the extracted text table (the importer stops
// at the diploma's own tile-drawing routine), so they are literals here, the
// same standing this port gives the SILPH CO. nurse's lines.

import type { GameState } from "../game.ts";

/** Frames before a button is listened to, so the A that opened it does not
 * also close it. */
const DIPLOMA_ARM_FRAMES = 3;

export interface DiplomaView {
  title: string;
  /** The trainer it certifies. */
  name: string;
  /** The body, already split to the width the frame leaves. */
  lines: string[];
  signature: string;
}

interface DiplomaGame {
  input: { pressed: { a?: boolean; b?: boolean; start?: boolean } };
  pop(): void;
  save: { player?: { name?: string } };
}

export class DiplomaState implements GameState {
  readonly kind = "diploma";
  private t = 0;

  constructor(
    private game: DiplomaGame,
    private onDone?: () => void,
  ) {}

  update(): void {
    this.t += 1;
    if (this.t < DIPLOMA_ARM_FRAMES) return;
    const p = this.game.input.pressed;
    if (p.a || p.b || p.start) {
      this.game.pop();
      this.onDone?.();
    }
  }

  view(): DiplomaView {
    return {
      title: "Diploma",
      name: this.game.save.player?.name ?? "RED",
      lines: [
        "Congratulations!",
        "This diploma",
        "certifies that",
        "you have",
        "completed your",
        "POKéDEX.",
      ],
      signature: "GAME FREAK",
    };
  }
}
