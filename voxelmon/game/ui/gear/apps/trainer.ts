// TRAINER: the card -- name, ID, money, play time, POKéDEX tally, steps and
// the eight badges (their own art from the trainer card sheet).
import * as Badges from "../../../rules/badges.ts";
import { formatPlayTime } from "../../trainercard.ts";
import { COLS, TILE_H, TILE_W, badgeIcon, box, center, row, sprite } from "../draw.ts";
import type { GearCtx } from "../ui.ts";

export function drawTrainer(ctx: GearCtx): void {
  const { host, data, save, gear } = ctx;
  const inv = save?.inventory ?? {};
  box(host, 0, 1, COLS, 9);
  sprite(host, data.atlas?.trainerCardPic ?? -1, 14 * TILE_W, 2 * TILE_H, 5 * TILE_W, 7 * TILE_H);
  // one style for every line: the label left, its value right-aligned
  // against the picture (columns 1-13); SEEN before OWN, as the dex says it
  const seen = Object.values(save?.pokedex?.seen ?? {}).filter(Boolean).length;
  const owned = Object.values(save?.pokedex?.owned ?? {}).filter(Boolean).length;
  const lines: [string, string][] = [
    ["NAME", String(save?.player?.name ?? "RED")],
    ["ID No.", String(save?.player?.id ?? 0).padStart(5, "0")],
    ["MONEY", `¥${save?.money ?? 0}`],
    ["TIME", formatPlayTime(Number(save?.playTime ?? 0))],
    ["SEEN", String(seen)],
    ["OWN", String(owned)],
  ];
  if (!gear.removed.steps) lines.push(["STEPS", String(gear.steps)]);
  lines.forEach(([label, value], k) => row(host, 2 + k, label, value, 1, 14));

  // the badges: two rows of four, each its art over its name
  const list = Badges.list(data);
  const cell = 12;
  list.slice(0, 8).forEach((b, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const cx = col * 5;
    const cy = 10 + row * 4;
    const have = !!inv[Badges.itemFor(b)];
    box(host, cx, cy, 5, 4);
    const px = cx * TILE_W + (5 * TILE_W - 2 * cell) / 2;
    const py = (cy + 1) * TILE_H - 3;
    // a badge you hold shows the badge; one you don't, the leader's face
    badgeIcon(host, data.atlas?.uiPage ?? -1, i, px, py, cell, !have);
  });
  // the count is a title on the card's bottom edge, over the badges it
  // counts (on the boxes' own bottom edge it broke two of them)
  center(host, 9, ` BADGES ${Badges.count(data, save)}/8 `);
}
