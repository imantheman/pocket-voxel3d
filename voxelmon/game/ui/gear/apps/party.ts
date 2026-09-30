// PARTY: the six cards, and a tap on one opens its summary -- INFO (the pic,
// number, types, status, trainer, experience), STATS and MOVES (each move's
// type, PP and, with the INFO level's assists, power, accuracy and effect).
import { hpBarTiles } from "../../../battle/ui.ts";
import { picPageFor } from "../../../battle/staging.ts";
import { expForLevel } from "../../../rules/growth.ts";
import {
  COLS, TILE_H, TILE_W, box, cursor, fit, pressedId, region, right,
  rule, sprite, text, tiles, wrap,
} from "../draw.ts";
import { assists, moveEffectLines, spoilers } from "../model.ts";
import { stepper, tabs, type GearCtx } from "../ui.ts";

export interface PartyMonLike {
  species: string;
  level: number;
  hp: number;
  exp?: number;
  stats?: { hp: number; attack: number; defense: number; speed: number; special: number };
  dvs?: { attack: number; defense: number; speed: number; special: number };
  status?: string | null;
  nickname?: string;
  moves?: { id: string; pp: number }[];
  otName?: string;
  otId?: number;
}

/** A mon's display name. */
export function monName(data: any, m: PartyMonLike): string {
  return m.nickname ?? data.pokemon?.[m.species]?.name ?? m.species;
}

/**
 * The 2x3 party grid (also the battle's PKMN panel). `cursor` marks a card
 * (-1 for none); `onTap` makes each card a target.
 */
export function drawPartyGrid(
  ctx: GearCtx,
  cursorAt: number,
  onTap?: (i: number) => void,
): void {
  const { host, data } = ctx;
  const party: PartyMonLike[] = ctx.save?.party ?? [];
  const colX = [0, 10];
  const rowY = [2, 7, 12];
  for (let i = 0; i < 6; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    if (i >= party.length) continue;
    const mon = party[i]!;
    const full = monName(data, mon);
    const name = full.length > 7 ? full.slice(0, 6) + "." : full;
    const maxHp = mon.stats?.hp ?? mon.hp;
    const lit = pressedId() === `party:${i}`;
    box(host, x0, y0, 10, 5, lit ? "light" : "dark");
    // the front pic in the nook; sprites draw over the grid, so the cursor
    // goes on the box corner rather than in the nook
    sprite(host, picPageFor(data, mon.species), (x0 + 1) * TILE_W, (y0 + 1) * TILE_H, 2 * TILE_W - 2, 2 * TILE_H - 1);
    if (cursorAt === i) cursor(host, x0, y0);
    text(host, x0 + 3, y0 + 1, name);
    text(host, x0 + 3, y0 + 2, `L${mon.level}`);
    tiles(host, x0 + 1, y0 + 3, hpBarTiles(mon.hp, maxHp, true).slice(1));
    if (mon.status) text(host, x0 + 6, y0 + 2, mon.status.slice(0, 3));
    if (onTap) region(`party:${i}`, x0, y0, 10, 5, () => onTap(i));
  }
}

export function drawParty(ctx: GearCtx): void {
  const { ui } = ctx;
  const party: PartyMonLike[] = ctx.save?.party ?? [];
  if (typeof ui.summary === "number" && party[ui.summary]) {
    drawSummary(ctx, ui.summary);
    return;
  }
  ui.summary = null;
  drawPartyGrid(ctx, -1, (i) => { ui.summary = i; ui.page ??= "info"; });
  if (party.length === 0) text(ctx.host, 4, 8, "NO POKéMON YET");
  else text(ctx.host, 2, 17, "TAP FOR A SUMMARY");
}

const PAGES = [
  { id: "info", label: "INFO" },
  { id: "stats", label: "STATS" },
  { id: "moves", label: "MOVES" },
];

function drawSummary(ctx: GearCtx, i: number): void {
  const { host, data, ui } = ctx;
  const party: PartyMonLike[] = ctx.save.party;
  const mon = party[i]!;
  const def = data.pokemon?.[mon.species] ?? {};
  const page = ui.page ?? "info";

  // the mon's own strip: pic, name, level, HP
  sprite(host, picPageFor(data, mon.species), 0, TILE_H * 1 + 2, 4 * TILE_W, 4 * TILE_H);
  text(host, 5, 2, fit(monName(data, mon), 10));
  right(host, 2, `L${mon.level}`);
  text(host, 5, 3, `No.${String(def.dex ?? 0).padStart(3, "0")}`);
  tiles(host, 5, 4, hpBarTiles(mon.hp, mon.stats?.hp ?? mon.hp, true));
  right(host, 5, `${mon.hp}/${mon.stats?.hp ?? mon.hp}`);
  rule(host, 6);

  if (page === "info") {
    const types: string[] = def.types ?? [];
    text(host, 1, 7, "TYPE");
    text(host, 7, 7, types.join("/"));
    text(host, 1, 8, "STATUS");
    text(host, 8, 8, mon.status ?? "OK");
    text(host, 1, 9, "OT");
    text(host, 7, 9, fit(mon.otName ?? String(ctx.save.player?.name ?? "RED"), 10));
    text(host, 1, 10, "ID No");
    text(host, 7, 10, String(mon.otId ?? ctx.save.player?.id ?? 0).padStart(5, "0"));
    const exp = mon.exp ?? 0;
    text(host, 1, 12, "EXP POINTS");
    right(host, 13, String(exp));
    if (mon.level < 100 && def.growthRate) {
      const next = expForLevel(def.growthRate, mon.level + 1);
      text(host, 1, 14, `TO L${mon.level + 1}`);
      right(host, 15, String(Math.max(0, next - exp)));
    }
  } else if (page === "stats") {
    const s = mon.stats;
    const rows: [string, number | undefined, number | undefined][] = [
      ["ATTACK", s?.attack, mon.dvs?.attack],
      ["DEFENSE", s?.defense, mon.dvs?.defense],
      ["SPEED", s?.speed, mon.dvs?.speed],
      ["SPECIAL", s?.special, mon.dvs?.special],
    ];
    const dv = spoilers(ctx.save);
    if (dv) right(host, 7, "DV", "dark", 20);
    rows.forEach(([label, v, d], k) => {
      const y = 8 + k * 2;
      text(host, 1, y, label);
      text(host, 10, y, String(v ?? "-").padStart(3, " "));
      if (dv && d !== undefined) right(host, y, String(d), "dark", 20);
    });
  } else {
    drawMoveList(ctx, mon.moves ?? [], 7);
  }

  tabs(ctx, PAGES, page, (id) => { ui.page = id; ui.move = null; }, 16);
  stepper(ctx, "BACK", () => { ui.summary = (i + party.length - 1) % party.length; ui.move = null; },
    () => { ui.summary = (i + 1) % party.length; ui.move = null; });
  // the stepper's middle is BACK to the grid
  region("summary:back", 3, 17, COLS - 6, 1, () => { ui.summary = null; ui.move = null; });
}

/**
 * Four moves, one per row pair: name / type and PP. A tap on a move opens
 * its details in place of the list (with the INFO assists).
 */
export function drawMoveList(ctx: GearCtx, moves: { id: string; pp: number }[], y0: number): void {
  const { host, data, ui } = ctx;
  if (typeof ui.move === "number" && moves[ui.move]) {
    drawMoveInfo(ctx, moves[ui.move]!, y0, () => { ui.move = null; });
    return;
  }
  moves.slice(0, 4).forEach((m, k) => {
    const d = data.moves?.[m.id] ?? {};
    const y = y0 + k * 2;
    const lit = pressedId() === `move:${k}`;
    text(host, 1, y, fit(d.name ?? m.id, 12), lit ? "fill" : "dark");
    text(host, 2, y + 1, d.type ?? "");
    right(host, y + 1, `PP ${m.pp}/${d.pp ?? m.pp}`);
    region(`move:${k}`, 0, y, COLS, 2, () => { ui.move = k; });
  });
}

/** One move in full: type, PP, power, accuracy and its effect in words. */
export function drawMoveInfo(
  ctx: GearCtx,
  m: { id: string; pp: number },
  y0: number,
  close: () => void,
  vs?: string,
): void {
  const { host, data } = ctx;
  const d = data.moves?.[m.id] ?? {};
  text(host, 1, y0, fit(d.name ?? m.id, 12));
  right(host, y0, d.type ?? "");
  text(host, 1, y0 + 1, `PP ${m.pp}/${d.pp ?? m.pp}`);
  if (assists(ctx.save)) {
    text(host, 1, y0 + 2, `PWR ${d.power ? d.power : "--"}`);
    right(host, y0 + 2, `ACC ${d.accuracy ?? "--"}`);
    const lines = moveEffectLines(m.id, d).flatMap((l) => wrap(l, 18));
    lines.slice(0, 3).forEach((l, i) => text(host, 1, y0 + 4 + i, l));
    if (vs) text(host, 1, y0 + 7, vs);
  }
  region("moveinfo:close", 0, y0, COLS, 9, close);
}
