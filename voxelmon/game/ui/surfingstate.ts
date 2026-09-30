// The Surfing Pikachu minigame as a game state: the ROM port
// (minigame/surfing.ts) runs one Game Boy frame per tick against its GB
// screen, which scene.ts mirrors into the core (gb/emit.ts). The Summer
// Beach House's SURFIN' DUDE starts it (world/yellowscripts.ts).
import type { GameState } from "../game.ts";
import { SurfingMinigame, type SurfingIo } from "../minigame/surfing.ts";
import type { GbVideo } from "../gb/video.ts";

/** Hardware joypad bits (PAD_*), the way the ROM reads hJoyHeld. */
const PAD: Record<string, number> = {
  a: 0x01, b: 0x02, select: 0x04, start: 0x08, right: 0x10, left: 0x20, up: 0x40, down: 0x80,
};

export interface SurfingHost {
  input: { state: Partial<Record<string, boolean>>; pressed: Partial<Record<string, boolean>> };
  pop(): void;
  data: { minigame?: { surfing?: { tilemaps: Record<string, number[]> } } };
  save: { surfingHiScore?: number; party?: { species: string; moves?: { id: string }[] }[] };
  npcRng: { byte(): number };
  audio?: {
    playOnce?(song: string): boolean;
    stopMusic?(): void;
    playSfx?(name: string): void;
    playPikaClip?(n: number): void;
  };
}

/** IsSurfingPikachuInParty: any Pikachu in the party that knows SURF. */
export function surfingPikachuInParty(save: SurfingHost["save"]): boolean {
  return (save.party ?? []).some((m) => m.species === "PIKACHU" && (m.moves ?? []).some((mv) => mv.id === "SURF"));
}

export class SurfingState implements GameState {
  readonly kind = "surfing";
  readonly minigame: SurfingMinigame | null;

  constructor(private game: SurfingHost, selectQuits: boolean, private onDone: () => void) {
    const maps = game.data.minigame?.surfing?.tilemaps;
    const io: SurfingIo = {
      random: () => game.npcRng.byte(),
      playMusic: (label) => { game.audio?.playOnce?.(label); },
      stopMusic: () => game.audio?.stopMusic?.(),
      playSfx: (name) => game.audio?.playSfx?.(name),
      pikaClip: (n) => game.audio?.playPikaClip?.(n),
      surfingPikachuInParty: surfingPikachuInParty(game.save),
      selectQuits,
      hiScore: game.save.surfingHiScore ?? 0,
      setHiScore: (bcd) => { game.save.surfingHiScore = bcd; },
    };
    // A dataset imported before the minigame's banks has nothing to draw
    // with: the state closes on its first tick rather than showing garbage.
    this.minigame = maps
      ? new SurfingMinigame(io, {
          beachIntro: maps.beachIntro ?? [],
          beachOutro: maps.beachOutro ?? [],
          title: maps.title ?? [],
          useControlPad: maps.useControlPad ?? [],
          toSurfRad: maps.toSurfRad ?? [],
          highScore1: maps.highScore1,
          highScore2: maps.highScore2,
        })
      : null;
  }

  update(): void {
    const { state, pressed } = this.game.input;
    let held = 0;
    let edge = 0;
    for (const [name, bit] of Object.entries(PAD)) {
      if (state[name]) held |= bit;
      if (pressed[name]) edge |= bit;
    }
    if (!this.minigame || !this.minigame.frame(held, edge)) {
      this.game.pop();
      this.onDone();
    }
  }

  /** What scene.ts mirrors into the core's GB screen. */
  video(): GbVideo | null {
    return this.minigame && !this.minigame.done ? this.minigame.video : null;
  }
}
