// The induction roll and the credits (pokered engine/events/hall_of_fame.asm
// HallOfFamePC, then engine/movie/credits.asm).
//
// Both are automatic: no menu, no cursor, nothing to choose. The Hall of Fame
// walks the party one mon at a time — front pic, dex number, name, level — and
// the credits roll the staff screens the importer already pulled out of the
// ROM (field.credits), each with its own mon, ending on THE END.
//
// Neither screen is skippable partway on purpose; they are the reward. B does
// advance a beat early, because forty seconds of credits on a handheld with a
// flat battery is not a reward.
import type { GameState } from "../game.ts";
import { picPageFor } from "../battle/staging.ts";
import type { HallOfFameEntry } from "../world/halloffame.ts";

/** Frames each mon holds the screen (HallOfFameDisplayMonInfo's waits). */
export const HOF_MON_FRAMES = 150;
/** Frames each credits screen holds. */
export const CREDITS_SCREEN_FRAMES = 110;
/** Frames THE END sits there before the script moves on. */
export const CREDITS_END_FRAMES = 180;

export interface HofMonView {
  /** The dex number, as "No.025" — blank when the species is unknown. */
  dexNo: string;
  name: string;
  level: string;
  /** Front pic page, or -1 in a pak cooked without one. */
  picPage: number;
}

export interface HallOfFameView {
  /** 0-based position in the party. */
  index: number;
  total: number;
  mon: HofMonView | null;
  /** The banner line under the roll. */
  title: string;
}

interface HofGame {
  input: { pressed: { a?: boolean; b?: boolean; start?: boolean } };
  pop(): void;
  save: { player?: { name?: string } };
  data: unknown;
}

function dexNumber(data: unknown, species: string): string {
  const mons = (data as { pokemon?: Record<string, { dex?: number }> })?.pokemon;
  const n = mons?.[species]?.dex;
  return n ? `No.${String(n).padStart(3, "0")}` : "";
}

export class HallOfFameState implements GameState {
  readonly kind = "halloffame";
  private index = 0;
  private timer = 0;

  constructor(
    private game: HofGame,
    private entry: HallOfFameEntry,
    private onDone: () => void,
  ) {}

  update(): void {
    this.timer += 1;
    const p = this.game.input.pressed;
    const skip = p.a === true || p.b === true || p.start === true;
    if (!skip && this.timer < HOF_MON_FRAMES) return;
    this.timer = 0;
    this.index += 1;
    if (this.index < this.entry.length) return;
    // The roll is over — hand back before popping, so whatever comes next
    // (the credits) is pushed while this screen is still the top one and the
    // stack never flashes back to the overworld underneath.
    const done = this.onDone;
    this.game.pop();
    done();
  }

  view(): HallOfFameView {
    const mon = this.entry[this.index];
    const name = String(this.game.save?.player?.name ?? "RED");
    return {
      index: this.index,
      total: this.entry.length,
      title: `${name}'s HALL OF FAME`,
      mon: mon
        ? {
            dexNo: dexNumber(this.game.data, mon.species),
            name: mon.nickname && mon.nickname.length > 0 ? mon.nickname : mon.species,
            level: `LEVEL${String(mon.level).padStart(3, " ")}`,
            picPage: picPageFor(this.game.data as never, mon.species),
          }
        : null,
    };
  }
}

export interface CreditsLine {
  column: number;
  text: string;
}

export interface CreditsScreenDef {
  lines: CreditsLine[];
  mon?: string;
  fade?: boolean;
}

export interface CreditsView {
  index: number;
  total: number;
  lines: CreditsLine[];
  /** The mon beside the staff names, or -1. */
  picPage: number;
  /** True on the last beat: THE END, and nothing else on screen. */
  theEnd: boolean;
}

/**
 * The staff roll. `screens` is field.credits.screens straight out of the
 * importer — each entry already carries its lines, their columns, and which
 * mon shares the screen.
 */
export class CreditsState implements GameState {
  readonly kind = "credits";
  private index = 0;
  private timer = 0;
  private ended = false;

  constructor(
    private game: HofGame,
    private screens: CreditsScreenDef[],
    private onDone: () => void,
  ) {}

  private get atEnd(): boolean {
    return this.index >= this.screens.length;
  }

  update(): void {
    this.timer += 1;
    const p = this.game.input.pressed;
    const skip = p.a === true || p.b === true || p.start === true;
    const hold = this.atEnd ? CREDITS_END_FRAMES : CREDITS_SCREEN_FRAMES;
    if (!skip && this.timer < hold) return;
    this.timer = 0;
    if (this.atEnd) {
      if (this.ended) return;
      this.ended = true;
      const done = this.onDone;
      this.game.pop();
      done();
      return;
    }
    this.index += 1;
  }

  view(): CreditsView {
    const s = this.screens[this.index];
    return {
      index: this.index,
      total: this.screens.length,
      lines: s?.lines ?? [],
      picPage: s?.mon ? picPageFor(this.game.data as never, s.mon) : -1,
      theEnd: this.atEnd,
    };
  }
}
