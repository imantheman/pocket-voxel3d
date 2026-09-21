// The evolution movie (engine/movie/evolution.asm), ported from
// gen1recomp src/ui/EvolutionState.lua.
//
// The mon's pic flashes back and forth with the evolved form, faster and
// faster, over "What? <MON> is evolving!". When the flashing has run its
// course the new form settles, cries, and the congratulations text prints.
//
// Holding B aborts it: EvolveMon polls the joypad on every flash iteration
// and a held B leaves the mon as it was, with "Huh? <MON> stopped
// evolving!". Two kinds are exempt -- a TRADE evolution never reaches the
// poll, and a STONE one reads the press and throws it away, because
// ItemUseEvoStone left wForceEvolution set. Neither exists in this port
// yet; `via` carries the distinction so they behave when they do.
import type { GameState } from "../game.ts";
import { picPageFor } from "../battle/staging.ts";
import type { PartyMon } from "../battle/mon.ts";
import type { VoxelmonData } from "../data.ts";

/** How long the forms trade places before the new one settles. */
export const EVO_FLASH_FRAMES = 220;

/** What made this happen; only a level-up may be called off. */
export type EvoVia = "LEVEL" | "ITEM" | "TRADE";

export interface EvolutionView {
  /** The form on screen this frame -- they alternate, or -1 with no art. */
  picPage: number;
  /** "What? / <MON> is / evolving!", and nothing once it has settled. */
  lines: string[];
}

interface EvoGame {
  input: { isDown(btn: "b"): boolean };
  data: VoxelmonData;
  pop(): void;
  showText(text: string, onDone?: () => void): void;
  audio?: { playCry?(species: string): void };
}

/**
 * How fast the forms trade places, in frames per form.
 *
 * EvolutionState.lua: `max(4, 28 - floor(t / 40) * 6)` -- half a second
 * apart to begin with, six frames quicker every forty, down to a floor of
 * four. The acceleration is the whole effect.
 */
export function flashPeriod(t: number): number {
  return Math.max(4, 28 - Math.floor(t / 40) * 6);
}

export class EvolutionState implements GameState {
  readonly kind = "evolution";
  private t = 0;
  private done = false;
  private canceled = false;
  private readonly cancelable: boolean;
  private readonly oldName: string;
  private readonly oldPage: number;
  private readonly newPage: number;

  constructor(
    private game: EvoGame,
    private mon: PartyMon,
    private newSpecies: string,
    private via: EvoVia,
    /** Applies the evolution; the screen decides WHEN, not what. */
    private evolve: (mon: PartyMon, to: string) => void,
    /** Runs once the congratulations page closes (the learn check). */
    private onDone: () => void,
  ) {
    this.cancelable = via === "LEVEL";
    this.oldName = mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species;
    this.oldPage = picPageFor(game.data, mon.species);
    this.newPage = picPageFor(game.data, newSpecies);
  }

  update(): void {
    this.t += 1;
    if (this.done) return;
    if (this.cancelable && this.game.input.isDown("b")) {
      this.done = true;
      this.canceled = true;
      const line = this.text("_StoppedEvolvingText", `Huh? ${this.oldName}\nstopped evolving!`);
      this.game.showText(line, () => this.finish());
      return;
    }
    if (this.t < EVO_FLASH_FRAMES) return;
    this.done = true;
    this.evolve(this.mon, this.newSpecies);
    this.game.audio?.playCry?.(this.newSpecies);
    const newName = this.game.data.pokemon[this.newSpecies]?.name ?? this.newSpecies;
    // _EvolvedText extracts truncated (it stops at a dynamic marker the
    // decoder does not follow), so the engine's wording stands here.
    this.game.showText(
      `Congratulations!\nYour ${this.oldName}\nevolved into\n${newName}!`,
      () => this.finish(),
    );
  }

  /** Off the stack first, so what follows lands on the world beneath. */
  private finish(): void {
    this.game.pop();
    this.onDone();
  }

  private text(key: string, fallback: string): string {
    const table = (this.game.data as { text?: Record<string, string> }).text;
    const line = table?.[key];
    return typeof line === "string" && line.length > 0 ? line : fallback;
  }

  view(): EvolutionView {
    if (this.done) {
      // A called-off evolution settles back on the form it started as.
      return { picPage: this.canceled ? this.oldPage : this.newPage, lines: [] };
    }
    const showNew = Math.floor(this.t / flashPeriod(this.t)) % 2 === 1;
    return {
      picPage: showNew ? this.newPage : this.oldPage,
      lines: ["What?", `${this.oldName} is`, "evolving!"],
    };
  }
}
