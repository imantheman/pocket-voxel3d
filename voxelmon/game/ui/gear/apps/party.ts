// PARTY: the six cards, and a tap on one opens its summary -- INFO (the pic,
// number, types, status, trainer, experience), STATS and MOVES (each move's
// type, PP and, with the INFO level's assists, power, accuracy and effect).
import { hpBarTiles } from "../../../battle/ui.ts";
import { picPageFor } from "../../../battle/staging.ts";
import { expForLevel } from "../../../rules/growth.ts";
import {
  COLS, TILE_H, TILE_W, box, center, cursor, fit, pressedId, region, right, row,
  rule, sprite, text, tiles, width, wrap,
} from "../draw.ts";
import { assists, moveEffectLines, spoilers, typeName } from "../model.ts";
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

/** The value column of the summary and dex pages' label rows. */
export const VALUE_X = 8;

/**
 * The strip atop a mon's summary and its dex page: the pic in rows 1-5,
 * the name on row 2 with `level` right-aligned beside it (the name cut to
 * leave a column between them), and the number on row 3 with `mark`
 * (OWN / SEEN) right-aligned beside it.
 */
export function monStrip(ctx: GearCtx, species: string, name: string, level: string, dex: number | undefined, mark = ""): void {
  const { host, data } = ctx;
  sprite(host, picPageFor(data, species), 0, TILE_H * 1 + 2, 4 * TILE_W, 4 * TILE_H);
  const end = COLS - 1 - (level ? width(level) + 1 : 0);
  text(host, 5, 2, fit(name, end - 5));
  if (level) right(host, 2, level);
  text(host, 5, 3, `No.${String(dex ?? 0).padStart(3, "0")}`);
  if (mark) right(host, 3, mark);
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
    // columns x0+3..x0+8 beside the pic: six glyphs, the last an ellipsis
    // when the name is longer (a seventh sat on the box's right border)
    const name = fit(monName(data, mon), 6);
    const maxHp = mon.stats?.hp ?? mon.hp;
    const lit = pressedId() === `party:${i}`;
    box(host, x0, y0, 10, 5, lit ? "light" : "dark");
    // the front pic in the nook; sprites draw over the grid, so the cursor
    // goes on the box corner rather than in the nook
    sprite(host, picPageFor(data, mon.species), (x0 + 1) * TILE_W, (y0 + 1) * TILE_H, 2 * TILE_W - 2, 2 * TILE_H - 1);
    if (cursorAt === i) cursor(host, x0, y0);
    text(host, x0 + 3, y0 + 1, name);
    // (a hundred drops the L, as the cartridge's PrintLevel does, so the
    // level is always three columns and the status tag never covers it)
    text(host, x0 + 3, y0 + 2, mon.level >= 100 ? String(mon.level) : `L${mon.level}`);
    tiles(host, x0 + 1, y0 + 3, hpBarTiles(mon.hp, maxHp, true).slice(1));
    // the status as a dark tag at the row's end: "L45" and "PSN" fill the
    // six columns exactly, and as plain text they ran together ("L45PSN")
    if (mon.status) text(host, x0 + 6, y0 + 2, mon.status.slice(0, 3).toUpperCase(), "fill");
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
  if (party.length === 0) center(ctx.host, 8, "NO POKéMON YET");
  else center(ctx.host, 17, "TAP FOR A SUMMARY");
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
  monStrip(ctx, mon.species, monName(data, mon), `L${mon.level}`, def.dex);
  tiles(host, 5, 4, hpBarTiles(mon.hp, mon.stats?.hp ?? mon.hp, true));
  // the numbers under the bar's end, as the cartridge sets them
  right(host, 5, `${mon.hp}/${mon.stats?.hp ?? mon.hp}`, "dark", 14);
  rule(host, 6);

  if (page === "info") {
    // three groups, a row apart, every value in one column (8): the types
    // (one a row: two side by side ran off the screen), the status; the
    // trainer; the experience, each number on its label's row
    const types: string[] = (def.types ?? []).map(typeName);
    text(host, 1, 7, "TYPE");
    types.slice(0, 2).forEach((t, k) => text(host, VALUE_X, 7 + k, t));
    text(host, 1, 9, "STATUS");
    text(host, VALUE_X, 9, String(mon.status ?? "OK").toUpperCase());
    text(host, 1, 11, "OT");
    text(host, VALUE_X, 11, fit(mon.otName ?? String(ctx.save.player?.name ?? "RED"), 10));
    text(host, 1, 12, "ID No.");
    text(host, VALUE_X, 12, String(mon.otId ?? ctx.save.player?.id ?? 0).padStart(5, "0"));
    const exp = mon.exp ?? 0;
    row(host, 14, "EXP POINTS", String(exp));
    if (mon.level < 100 && def.growthRate) {
      const next = expForLevel(def.growthRate, mon.level + 1);
      row(host, 15, `TO L${mon.level + 1}`, String(Math.max(0, next - exp)));
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
    // values right-aligned in one column; the DVs (SPOILERS) a column in
    // from the edge like every other right-hand value
    if (dv) right(host, 7, "DV");
    rows.forEach(([label, v, d], k) => {
      const y = 8 + k * 2;
      text(host, 1, y, label);
      right(host, y, String(v ?? "-"), "dark", 15);
      if (dv && d !== undefined) right(host, y, String(d));
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
    text(host, 1, y, fit(d.name ?? m.id, 18), lit ? "fill" : "dark");
    // (the dataset's PSYCHIC_TYPE printed whole ran under the PP)
    text(host, 2, y + 1, typeName(d.type));
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
  // the name on its own row; PP and the type, then power and accuracy,
  // each pair at the row's two ends (a long name and its type collided)
  text(host, 1, y0, fit(d.name ?? m.id, 18));
  text(host, 1, y0 + 1, `PP ${m.pp}/${d.pp ?? m.pp}`);
  right(host, y0 + 1, typeName(d.type));
  if (assists(ctx.save)) {
    text(host, 1, y0 + 2, `PWR ${d.power ? d.power : "--"}`);
    right(host, y0 + 2, `ACC ${d.accuracy ?? "--"}`);
    const lines = moveEffectLines(m.id, d).flatMap((l) => wrap(l, 18));
    lines.slice(0, 3).forEach((l, i) => text(host, 1, y0 + 4 + i, l));
    if (vs) text(host, 1, y0 + 7, vs);
  }
  region("moveinfo:close", 0, y0, COLS, 9, close);
}
