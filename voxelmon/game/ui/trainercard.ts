// The TRAINER CARD. Ports gen1recomp src/ui/TrainerCard.lua (pokered
// engine/menus/start_sub_menus.asm DrawTrainerInfo): NAME / MONEY / TIME in
// the top card, the BADGES banner, then the numbered badge grid.
//
// The art is the ROM's own: import/stages/trainercard.ts pulls the four 2bpp
// strips (GymLeaderFaceAndBadgeTileGraphics, BadgeNumbersTileGraphics,
// TrainerInfoTextBoxTileGraphics, CircleTile) and cook/atlas.ts packs them
// into the UI page's unused low tile codes (voxel-spec.ts UI_TILE), so the
// card draws with plain uiTile calls — the gym leader's face in an unearned
// slot, the badge itself once it is won, exactly as DrawBadges picks.
//
// The portrait is Red's battle front pic cooked opaque (cook/cli.ts
// trainerCardPic): a ScreenPic draws under the ui layer, so the card leaves
// its seven-by-seven cells empty and the pic shows through them.
//
// The one deviation is the grid's spacing. The original places the badge
// rows at 24-pixel pitch with the number 4px left and 6px up from the badge;
// the ui layer is a tile grid, so the rows sit at 2 tiles and the number sits
// in the cell to the badge's left.
//
// Either button dismisses it (StartMenu_TrainerInfo -> WaitForTextScroll
// ButtonPress -> RedisplayStartMenu), so the start menu is still underneath
// with its cursor where it was.
import { GB_H, GB_W, TILE_PX, VIEW_H, VIEW_W } from "../../../contracts/spec/voxel-spec.ts";
import type { GameState } from "../game.ts";
import * as Badges from "../rules/badges.ts";

// core/src/ui.rs UI_SCALE / UI_ORIGIN_X / UI_TILE_PX: where a ui cell lands
// in the guest's 480x272 screen, which is the space a pic is placed in.
const UI_SCALE = VIEW_H / GB_H;
const UI_ORIGIN_X = (VIEW_W - GB_W * UI_SCALE) / 2;
const UI_TILE_PX = TILE_PX * UI_SCALE;

/** The portrait's cells, top-right of the info box (DrawTrainerInfo's 104,4). */
export const CARD_PIC_CELL = { x: 13, y: 1, w: 7, h: 7 } as const;

/** A run of ui cells as a screen rect for the pic op. */
export function cellsToPicRect(c: { x: number; y: number; w: number; h: number }): {
  x: number; y: number; w: number; h: number;
} {
  return {
    x: Math.round(UI_ORIGIN_X + c.x * UI_TILE_PX),
    y: Math.round(c.y * UI_TILE_PX),
    w: Math.round(c.w * UI_TILE_PX),
    h: Math.round(c.h * UI_TILE_PX),
  };
}

/** Those cells as a screen rect for the pic op. */
export const CARD_PIC_RECT = cellsToPicRect(CARD_PIC_CELL);

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
  /** Opaque Red front pic, or -1 in a pak cooked before it existed. */
  picPage: number;
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
      picPage: this.game.data?.atlas?.trainerCardPic ?? -1,
    };
  }
}
