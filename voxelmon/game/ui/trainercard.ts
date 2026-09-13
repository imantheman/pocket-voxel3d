// The TRAINER CARD. Ports gen1recomp src/ui/TrainerCard.lua (pokered
// engine/menus/start_sub_menus.asm DrawTrainerInfo): NAME / MONEY / TIME in
// the top card, the BADGES banner, then the numbered badge grid.
//
// One deviation, and it is the whole visual difference: the original draws
// the grid from trainer_card/badges.2bpp — eight [face, badge] tile pairs,
// where an unearned badge shows a blank numbered face. Those sheets are not
// in the pak (the cooker packs the font pages and the map/mon atlases, not
// the trainer-card art), so the grid is drawn in the font: an earned badge
// prints its name, an unearned one prints dots after its number. Same
// information, same eight numbered slots, no new atlas page.
//
// Either button dismisses it (StartMenu_TrainerInfo -> WaitForTextScroll
// ButtonPress -> RedisplayStartMenu), so the start menu is still underneath
// with its cursor where it was.
import type { GameState } from "../game.ts";
import * as Badges from "../rules/badges.ts";

export interface TrainerCardBadge {
  /** 1-based badge number, the grid position. */
  n: number;
  name: string;
  owned: boolean;
}

export interface TrainerCardView {
  name: string;
  money: number;
  /** Preformatted H:MM — the card's own field, not a duration to re-derive. */
  time: string;
  badges: TrainerCardBadge[];
}

/** TrainerCard.lua:145 — floor to seconds, then H:MM. */
export function formatPlayTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export class TrainerCardState implements GameState {
  readonly kind = "trainercard";

  constructor(private game: { input: any; pop(): void; save: any; data: any }) {}

  update(): void {
    const p = this.game.input.pressed;
    if (p.a || p.b || p.start) this.game.pop();
  }

  view(): TrainerCardView {
    const save = this.game.save ?? {};
    const inv = save.inventory ?? {};
    return {
      name: String(save.player?.name ?? "RED"),
      money: Number(save.money ?? 0),
      time: formatPlayTime(Number(save.playTime ?? 0)),
      badges: Badges.list(this.game.data).map((entry, i) => ({
        n: i + 1,
        name: Badges.label(entry),
        owned: !!inv[Badges.itemFor(entry)],
      })),
    };
  }
}
