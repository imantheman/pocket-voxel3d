// STAMPS: every area with trainers or items, how much of it is done, and a
// stamp once it is -- all its trainers beaten and its items picked up (the
// hidden ones too, under SPOILERS). A tap on an area lists what is left.
import { COLS, center, cursor, fit, pressedId, region, right, row, text } from "../draw.ts";
import { mapItems, mapTrainers, spoilers, stampAreas, stampDone, type StampArea } from "../model.ts";
import { backRow, stepper, type GearCtx } from "../ui.ts";

const PER_PAGE = 4;

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
  text(host, 1, 1, `STAMPS ${done}/${areas.length}`);
  const pages = Math.ceil(areas.length / PER_PAGE);
  ui.top = Math.min(ui.top ?? 0, (pages - 1) * PER_PAGE);
  // an area a block of three rows -- its name (STAMP at the end once it
  // is done), then TRAINERS and ITEMS with their counts right-aligned to the edge --
  // and a row between blocks (the two counts shared a row and overlapped)
  areas.slice(ui.top, ui.top + PER_PAGE).forEach((a, k) => {
    const y = 2 + k * 4;
    const lit = pressedId() === `stamp:${a.name}`;
    const ink = lit ? "fill" : "dark";
    const stamped = stampDone(a);
    if (stamped) cursor(host, 0, y, ink);
    text(host, 1, y, fit(a.name, stamped ? 13 : 19), ink);
    if (stamped) right(host, y, "STAMP", ink, COLS);
    row(host, y + 1, "TRAINERS", `${a.beaten}/${a.trainers}`, 2, COLS);
    row(host, y + 2, "ITEMS", `${a.found}/${a.items}`, 2, COLS);
    region(`stamp:${a.name}`, 0, y, COLS, 3, () => { ui.area = a.name; });
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
  // a column clear of either edge, like the rest of the gear
  text(host, 1, 1, fit(a.name, 18));
  const lines: string[] = [];
  for (const id of a.maps) {
    const place = id.replace(/_/g, " ");
    for (const t of mapTrainers(data, save, id)) if (!t.beaten) lines.push(fit(`${t.name} ${place}`, 18));
    for (const it of mapItems(data, save, id)) {
      if (it.taken || (it.hidden && !spoilers(save))) continue;
      lines.push(fit(`${it.hidden ? "HIDDEN " : ""}${it.name} ${place}`, 18));
    }
  }
  if (lines.length === 0) center(host, 8, "ALL DONE HERE!");
  lines.slice(0, 14).forEach((l, i) => text(host, 1, 3 + i, l));
  backRow(ctx, () => { ui.area = null; });
}
