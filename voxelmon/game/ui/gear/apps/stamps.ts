// STAMPS: every area with trainers or items, how much of it is done, and a
// stamp once it is -- all its trainers beaten and its items picked up (the
// hidden ones too, under SPOILERS). A tap on an area lists what is left.
import { COLS, center, cursor, fit, pressedId, region, right, text } from "../draw.ts";
import { mapItems, mapTrainers, spoilers, stampAreas, stampDone, type StampArea } from "../model.ts";
import { backRow, stepper, type GearCtx } from "../ui.ts";

const PER_PAGE = 7;

export function drawStamps(ctx: GearCtx): void {
  const { host, data, save, ui } = ctx;
  const areas = stampAreas(data, save, spoilers(save)).filter((a) => a.visited);
  if (ui.area) {
    const a = areas.find((x) => x.name === ui.area);
    if (a) { drawArea(ctx, a); return; }
    ui.area = null;
  }
  if (areas.length === 0) {
    center(host, 7, "GO EXPLORE!");
    center(host, 9, "EVERY AREA YOU VISIT");
    center(host, 10, "EARNS A STAMP WHEN");
    center(host, 11, "YOU FINISH IT.");
    return;
  }
  const done = areas.filter(stampDone).length;
  text(host, 0, 1, `STAMPS ${done}/${areas.length}`);
  const pages = Math.ceil(areas.length / PER_PAGE);
  ui.top = Math.min(ui.top ?? 0, (pages - 1) * PER_PAGE);
  areas.slice(ui.top, ui.top + PER_PAGE).forEach((a, k) => {
    const y = 2 + k * 2;
    const lit = pressedId() === `stamp:${a.name}`;
    const ink = lit ? "fill" : "dark";
    if (stampDone(a)) cursor(host, 0, y, ink);
    text(host, 1, y, fit(a.name, 14), ink);
    text(host, 1, y + 1, `TRAINERS ${a.beaten}/${a.trainers}`);
    right(host, y + 1, `ITEMS ${a.found}/${a.items}`, "dark", 20);
    if (stampDone(a)) right(host, y, "STAMP", ink, 20);
    region(`stamp:${a.name}`, 0, y, COLS, 2, () => { ui.area = a.name; });
  });
  if (pages > 1) {
    const at = Math.floor(ui.top / PER_PAGE);
    stepper(ctx, `${at + 1}/${pages}`,
      () => { ui.top = ((at + pages - 1) % pages) * PER_PAGE; },
      () => { ui.top = ((at + 1) % pages) * PER_PAGE; }, 17);
  }
}

/** What is left in one area: unbeaten trainers, then items not found. */
function drawArea(ctx: GearCtx, a: StampArea): void {
  const { host, data, save, ui } = ctx;
  text(host, 0, 1, fit(a.name, 20));
  const lines: string[] = [];
  for (const id of a.maps) {
    const place = id.replace(/_/g, " ");
    for (const t of mapTrainers(data, save, id)) if (!t.beaten) lines.push(fit(`${t.name} ${place}`, 20));
    for (const it of mapItems(data, save, id)) {
      if (it.taken || (it.hidden && !spoilers(save))) continue;
      lines.push(fit(`${it.hidden ? "HIDDEN " : ""}${it.name} ${place}`, 20));
    }
  }
  if (lines.length === 0) center(host, 8, "ALL DONE HERE!");
  lines.slice(0, 14).forEach((l, i) => text(host, 0, 3 + i, l));
  backRow(ctx, () => { ui.area = null; });
}
